// Implementação do shim. Objective-C (.m) porque os callbacks de clipboard
// usam NSPasteboard. Inclui o ghostty.h real do xcframework — a ABI das structs
// é resolvida pelo compilador, não reproduzida à mão no Rust.
#import "ghostty_shim.h"
#import <AppKit/AppKit.h>
#import <CoreText/CoreText.h>
#import <Carbon/Carbon.h>
#import <dispatch/dispatch.h>
#import "ghostty.h"

// App global do Ghostty (singleton, como no app oficial e no wrapper Swift).
static ghostty_app_t g_app = NULL;
static ghostty_config_t g_config = NULL;

// Register only in this process; never install fonts or rewrite the user's Ghostty config.
bool alethe_ghostty_surface_set_font(void *surface, const char *config_path, const char *font_dir) {
    if (surface == NULL || g_config == NULL) return false;
    NSString *directory = [NSString stringWithUTF8String:font_dir];
    for (NSString *file in @[@"Regular", @"Bold", @"Italic", @"BoldItalic"]) {
        NSString *path = [directory stringByAppendingPathComponent:[file stringByAppendingString:@".ttf"]];
        NSURL *url = [NSURL fileURLWithPath:path];
        CTFontManagerRegisterFontsForURL((__bridge CFURLRef)url, kCTFontManagerScopeProcess, NULL);
    }
    ghostty_config_t config = ghostty_config_clone(g_config);
    if (config == NULL) return false;
    ghostty_config_load_file(config, config_path);
    ghostty_config_finalize(config);
    bool valid = ghostty_config_diagnostics_count(config) == 0;
    if (valid) ghostty_surface_update_config((ghostty_surface_t)surface, config);
    ghostty_config_free(config);
    return valid;
}

// Captura do ÚLTIMO key enviado à surface — instrumentação para o teste headless
// de digitação/dead-keys provar o que de fato chega ao terminal (sem depender de
// ler o grid). Atualizado no ponto de chamada de ghostty_surface_key no keyDown.
static char g_last_key_text[64] = {0};
static bool g_last_key_composing = false;

// Registro simples de surfaces vivas, para redesenhá-las após cada tick (o
// terminal precisa de um draw quando há output/cursor; o Ghostty sinaliza via
// wakeup, e nós desenhamos no tick). Capacidade fixa pequena é suficiente.
@class AletheGhosttyView;

#define ALETHE_MAX_SURFACES 256
static ghostty_surface_t g_surfaces[ALETHE_MAX_SURFACES];
static AletheGhosttyView *g_views[ALETHE_MAX_SURFACES];
static int g_surface_count = 0;

// Contador de draws emitidos — instrumentação para o teste de render contínuo
// (#2). Cada chamada a draw incrementa; o teste verifica que cresce sozinho.
static unsigned long long g_draw_count = 0;

static void alethe_draw_surface(ghostty_surface_t s) {
    if (!s) return;
    ghostty_surface_draw(s);
    g_draw_count++;
}

static void alethe_display_link_start(void);
static void alethe_display_link_stop(void);

static void alethe_register_surface(ghostty_surface_t s, AletheGhosttyView *v) {
    if (g_surface_count < ALETHE_MAX_SURFACES) {
        g_surfaces[g_surface_count] = s;
        g_views[g_surface_count] = v;
        g_surface_count++;
        // Primeira surface viva → liga o render contínuo.
        if (g_surface_count == 1) alethe_display_link_start();
    }
}
static void alethe_unregister_surface(ghostty_surface_t s) {
    for (int i = 0; i < g_surface_count; i++) {
        if (g_surfaces[i] == s) {
            g_surfaces[i] = g_surfaces[g_surface_count - 1];
            g_views[i] = g_views[g_surface_count - 1];
            g_views[g_surface_count - 1] = nil;
            g_surface_count--;
            // Nenhuma surface viva → desliga (não gasta GPU à toa).
            if (g_surface_count == 0) alethe_display_link_stop();
            return;
        }
    }
}
static void alethe_draw_all(void) {
    for (int i = 0; i < g_surface_count; i++) {
        if (g_surfaces[i]) alethe_draw_surface(g_surfaces[i]);
    }
}

// ---- Render contínuo (#2) -------------------------------------------------
// Render loop dirigido por um NSTimer a ~60Hz agendado na main run loop em
// NSRunLoopCommonModes. Roda na main thread (onde draw é seguro) e dispara
// tanto no app quanto sob `NSRunLoop runMode:` (testes headless) — ao contrário
// do CVDisplayLink, cujo callback vem de outra thread e não é drenado por
// runMode. A cada tick desenha todas as surfaces vivas.
//
// Objeto-alvo do NSTimer (precisa de um target ObjC com seletor).
@interface AletheRenderTicker : NSObject
- (void)tick:(NSTimer *)t;
@end
@implementation AletheRenderTicker
- (void)tick:(NSTimer *)t {
    (void)t;
    // Avança o IO do terminal a cada frame e desenha. O tick processa o echo do
    // PTY (output do shell) e o draw pinta — cobre tanto output do shell quanto
    // cursor piscando sem depender só do wakeup.
    if (g_surface_count > 0) {
        if (g_app) ghostty_app_tick(g_app);
        alethe_draw_all();
    }
}
@end

static NSTimer *g_render_timer = NULL;
static AletheRenderTicker *g_render_ticker = NULL;

static void alethe_display_link_start(void) {
    if (g_render_timer != NULL) return;
    if (g_render_ticker == NULL) g_render_ticker = [[AletheRenderTicker alloc] init];
    g_render_timer = [NSTimer timerWithTimeInterval:(1.0 / 60.0)
                                             target:g_render_ticker
                                           selector:@selector(tick:)
                                           userInfo:nil
                                            repeats:YES];
    // Adiciona ao run loop da thread atual (no app: a main thread, via
    // run_on_main_thread no spawn; em teste: a thread do teste). CommonModes
    // para continuar disparando durante drags/resize.
    [[NSRunLoop currentRunLoop] addTimer:g_render_timer forMode:NSRunLoopCommonModes];
}

static void alethe_display_link_stop(void) {
    if (g_render_timer == NULL) return;
    [g_render_timer invalidate];
    g_render_timer = NULL;
}

// ---- Callbacks de runtime -------------------------------------------------
// O wakeup é chamado fora da main thread; agenda o tick na main queue.
static void shim_wakeup_cb(void *userdata) {
    (void)userdata;
    dispatch_async(dispatch_get_main_queue(), ^{
        if (g_app) ghostty_app_tick(g_app);
        // Após processar o trabalho pendente, redesenha as surfaces para o
        // output/cursor aparecerem sem depender de um resize.
        alethe_draw_all();
    });
}

// Não tratamos ações por enquanto (título, notificação, etc.) — retornar false
// diz ao Ghostty para aplicar o comportamento padrão. Paridade vem depois.
static bool shim_action_cb(ghostty_app_t app,
                           ghostty_target_s target,
                           ghostty_action_s action) {
    (void)app; (void)target; (void)action;
    return false;
}

static void shim_close_surface_cb(void *userdata, bool process_alive) {
    (void)userdata; (void)process_alive;
}

static void shim_write_clipboard_cb(void *userdata,
                                    ghostty_clipboard_e clipboard,
                                    const ghostty_clipboard_content_s *contents,
                                    size_t len,
                                    bool confirm) {
    (void)userdata; (void)clipboard; (void)confirm;
    if (len == 0 || contents == NULL || contents[0].data == NULL) return;
    NSString *s = [NSString stringWithUTF8String:contents[0].data];
    if (s == nil) return;
    NSPasteboard *pb = [NSPasteboard generalPasteboard];
    [pb clearContents];
    [pb setString:s forType:NSPasteboardTypeString];
}

// O userdata da surface é a AletheGhosttyView dona dela (setado em cfg.userdata
// no surface_new). Este helper (definido após a classe) resolve view -> surface.
// Antes, cfg.userdata era NULL e o guard abaixo abortava TODO paste (Cmd+V
// silenciosamente morto) — o Ghostty pedia o clipboard e ninguém respondia.
static ghostty_surface_t alethe_surface_for_userdata(void *userdata);

static bool shim_read_clipboard_cb(void *userdata,
                                   ghostty_clipboard_e clipboard,
                                   void *request) {
    (void)clipboard;
    if (request == NULL) return false;
    ghostty_surface_t surface = alethe_surface_for_userdata(userdata);
    if (surface == NULL) return false;
    NSString *s = [[NSPasteboard generalPasteboard] stringForType:NSPasteboardTypeString];
    const char *c = s ? [s UTF8String] : "";
    ghostty_surface_complete_clipboard_request(surface, c, request, false);
    return true;
}

static void shim_confirm_read_clipboard_cb(void *userdata,
                                           const char *str,
                                           void *request,
                                           ghostty_clipboard_request_e req) {
    (void)req;
    if (str == NULL || request == NULL) return;
    ghostty_surface_t surface = alethe_surface_for_userdata(userdata);
    if (surface == NULL) return;
    ghostty_surface_complete_clipboard_request(surface, str, request, true);
}

// ---- Tradução de modificadores AppKit -> Ghostty --------------------------
static ghostty_input_mods_e alethe_mods(NSEventModifierFlags f) {
    uint32_t m = GHOSTTY_MODS_NONE;
    if (f & NSEventModifierFlagShift)   m |= GHOSTTY_MODS_SHIFT;
    if (f & NSEventModifierFlagControl) m |= GHOSTTY_MODS_CTRL;
    if (f & NSEventModifierFlagOption)  m |= GHOSTTY_MODS_ALT;
    if (f & NSEventModifierFlagCommand) m |= GHOSTTY_MODS_SUPER;
    if (f & NSEventModifierFlagCapsLock) m |= GHOSTTY_MODS_CAPS;
    return (ghostty_input_mods_e)m;
}

// ---- NSView customizada que encaminha input pra surface -------------------
// Encaminha teclado, mouse, scroll e foco pra surface. O teclado usa composição
// MANUAL de dead-keys via UCKeyTranslate (não interpretKeyEvents — esse, na
// WebView do Tauri, roteava o input pra a WKWebView e o texto sumia). Assim a
// tecla de acento morto (ABNT2: ´ ` ~ ^) compõe com a vogal seguinte sem
// depender do roteamento de input-context do AppKit.
@interface AletheGhosttyView : NSView <NSTextInputClient>
@property (nonatomic, assign) ghostty_surface_t surface;
// Estado de dead-key do UCKeyTranslate (memória de composição). PER-VIEW, nunca
// global: guarda o acento morto pendente entre um keyDown e o próximo.
@property (nonatomic, assign) UInt32 deadKeyState;
// (legado NSTextInputClient — mantido mas não usado no caminho de digitação)
@property (nonatomic, strong) NSMutableArray<NSString *> *collectedText;
@property (nonatomic, assign) BOOL collecting;
@property (nonatomic, strong) NSString *markedText;
@property (nonatomic, assign) SEL lastCommand;
@end

@implementation AletheGhosttyView
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)becomeFirstResponder {
    if (self.surface) ghostty_surface_set_focus(self.surface, true);
    return [super becomeFirstResponder];
}
- (BOOL)resignFirstResponder {
    if (self.surface) ghostty_surface_set_focus(self.surface, false);
    return [super resignFirstResponder];
}

// Compõe a tecla via UCKeyTranslate, mantendo o estado de dead-key da view.
// Retorna o texto composto (vazio se a tecla foi um acento morto pendente), ou
// nil se a layout não pôde ser lida (chamador faz fallback p/ event.characters).
// *outDead = YES quando esta tecla iniciou/continuou uma composição (o
// deadKeyState mudou de 0 -> não-zero), distinguindo de teclas de controle
// (Enter/setas) que também produzem 0 caracteres mas NÃO são dead-keys.
- (NSString *)alethe_composeForEvent:(NSEvent *)event deadPending:(BOOL *)outDead {
    *outDead = NO;
    TISInputSourceRef src = TISCopyCurrentKeyboardLayoutInputSource();
    if (!src) return nil;
    CFDataRef layoutData = (CFDataRef)TISGetInputSourceProperty(src, kTISPropertyUnicodeKeyLayoutData);
    if (!layoutData) { CFRelease(src); return nil; }
    const UCKeyboardLayout *layout = (const UCKeyboardLayout *)CFDataGetBytePtr(layoutData);

    NSEventModifierFlags f = event.modifierFlags;
    UInt32 carbonMods = 0;
    if (f & NSEventModifierFlagShift)    carbonMods |= (shiftKey  >> 8) & 0xFF;
    if (f & NSEventModifierFlagOption)   carbonMods |= (optionKey >> 8) & 0xFF;
    if (f & NSEventModifierFlagCapsLock) carbonMods |= (alphaLock >> 8) & 0xFF;
    // Ctrl/Cmd ficam de fora — atalhos seguem como tecla crua.

    UInt32 stateBefore = self.deadKeyState;
    UniChar buf[8];
    UniCharCount n = 0;
    OSStatus s = UCKeyTranslate(layout, (UInt16)event.keyCode, kUCKeyActionDown,
                                carbonMods, LMGetKbdType(), 0,
                                &self->_deadKeyState,
                                sizeof(buf) / sizeof(buf[0]), &n, buf);
    CFRelease(src);
    if (s != noErr) return nil;
    if (n == 0) {
        // Sem caracteres. Só é dead-key se o estado MUDOU (acento morto pendente).
        // Teclas de controle (Enter/setas) deixam o estado em 0 -> não é dead-key.
        if (self.deadKeyState != 0 && self.deadKeyState != stateBefore) {
            *outDead = YES;
        }
        return @"";
    }
    return [NSString stringWithCharacters:buf length:n];
}

// Atalhos com Cmd (Cmd+V = paste, etc.) chegam primeiro como
// performKeyEquivalent — sem este override, o menu/WebView do Tauri os consome
// e o terminal nunca vê o paste. Espelha o app oficial do Ghostty
// (SurfaceView_AppKit.swift): se a view está focada e o Ghostty reconhece o
// evento como keybinding, processa via keyDown e consome. Ctrl+letra NÃO passa
// por aqui (chega naturalmente no keyDown), preservando os atalhos do app.
- (BOOL)performKeyEquivalent:(NSEvent *)event {
    if (event.type != NSEventTypeKeyDown) return NO;
    if (!self.surface) return NO;
    if (self.window.firstResponder != self) return NO;
    if (!(event.modifierFlags & NSEventModifierFlagCommand)) return NO;

    ghostty_input_key_s key;
    memset(&key, 0, sizeof(key));
    key.action = GHOSTTY_ACTION_PRESS;
    key.mods = alethe_mods(event.modifierFlags);
    key.keycode = event.keyCode;
    NSString *bare = [event charactersByApplyingModifiers:0];
    if (bare.length == 0) bare = event.charactersIgnoringModifiers;
    if (bare.length > 0) key.unshifted_codepoint = [bare characterAtIndex:0];
    NSEventModifierFlags consumed =
        event.modifierFlags & ~(NSEventModifierFlagControl | NSEventModifierFlagCommand);
    key.consumed_mods = alethe_mods(consumed);
    NSString *chars = event.characters;
    key.text = chars.length > 0 ? [chars UTF8String] : NULL;

    ghostty_binding_flags_e flags = 0;
    if (!ghostty_surface_key_is_binding(self.surface, key, &flags)) return NO;
    [self keyDown:event];
    return YES;
}

- (void)keyDown:(NSEvent *)event {
    if (!self.surface) return;

    ghostty_input_key_s key;
    memset(&key, 0, sizeof(key));
    key.action = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS;
    key.mods = alethe_mods(event.modifierFlags);
    key.keycode = event.keyCode;
    // unshifted_codepoint = a tecla física SEM modificadores (o Ghostty usa isto
    // pra casar atalhos: Ctrl+R -> precisa ver 'r', U+0072). Cuidado: sob Ctrl,
    // -charactersIgnoringModifiers retorna o CARACTERE DE CONTROLE (Ctrl+R ->
    // U+0012), não a letra — "IgnoringModifiers" ignora Shift/Option, NÃO Ctrl.
    // Isso quebrava TODO Ctrl+letra (reverse-search, etc.). Usamos
    // -charactersByApplyingModifiers:0, que devolve a tecla base ('r'), com
    // fallback pro comportamento antigo se vier vazio (teclas não-imprimíveis).
    NSString *bare = [event charactersByApplyingModifiers:0];
    if (bare.length == 0) bare = event.charactersIgnoringModifiers;
    if (bare.length > 0) key.unshifted_codepoint = [bare characterAtIndex:0];
    NSEventModifierFlags consumed =
        event.modifierFlags & ~(NSEventModifierFlagControl | NSEventModifierFlagCommand);
    key.consumed_mods = alethe_mods(consumed);

    bool ctrlOrCmd = (event.modifierFlags &
        (NSEventModifierFlagControl | NSEventModifierFlagCommand)) != 0;

    const char *utf8 = NULL;     // texto a enviar (NULL = nenhum)
    bool composing = false;      // true = acento morto pendente

    if (ctrlOrCmd) {
        // Ctrl+letra (Ctrl+R, Ctrl+A, Ctrl+L…): o KeyEncoder do Ghostty gera a
        // sequência de controle (Ctrl+R -> 0x12) A PARTIR do `text`, que deve ser
        // a LETRA com o Control removido — NÃO NULL e NÃO o char de controle cru.
        // Isto espelha `NSEvent.ghosttyCharacters` do app oficial do Ghostty
        // (macos/Sources/Ghostty/NSEvent+Extension.swift): quando o caractere é
        // um único char de controle (< 0x20), envia characters(byApplyingModifiers:
        // sem .control). Antes mandávamos NULL, e por isso Ctrl+R não funcionava.
        // Cmd (SUPER) continua sem texto: é atalho de app, não entra no terminal.
        utf8 = NULL;
        NSString *chars = event.characters;
        if (chars.length == 1 && [chars characterAtIndex:0] < 0x20) {
            NSEventModifierFlags noCtrl =
                event.modifierFlags & ~NSEventModifierFlagControl;
            NSString *decoded = [event charactersByApplyingModifiers:noCtrl];
            if (decoded.length > 0) utf8 = [decoded UTF8String];
        }
    } else {
        BOOL dead = NO;
        NSString *composed = [self alethe_composeForEvent:event deadPending:&dead];
        if (composed == nil) {
            // Layout não-lido: fallback exato ao caminho comprovado.
            NSString *chars = event.characters;
            if (chars.length > 0) utf8 = [chars UTF8String];
        } else if (dead) {
            // Acento morto pendente: não manda texto; o deadKeyState carrega
            // pro próximo keyDown, que vai compor (´ + a => "á").
            utf8 = NULL;
            composing = true;
        } else if (composed.length > 0) {
            // Caractere final (letra, símbolo, ou acento já composto).
            utf8 = [composed UTF8String];
        } else {
            // Sem texto e sem dead-key: tecla de controle (Enter/setas/Tab).
            utf8 = NULL;
        }
    }

    key.composing = composing;
    key.text = utf8;

    // Instrumentação de teste (sem efeito no app): registra o que vai à surface.
    g_last_key_composing = composing;
    if (utf8) {
        strncpy(g_last_key_text, utf8, sizeof(g_last_key_text) - 1);
        g_last_key_text[sizeof(g_last_key_text) - 1] = '\0';
    } else {
        g_last_key_text[0] = '\0';
    }

    ghostty_surface_key(self.surface, key);
}

// ---- NSTextInputClient ----------------------------------------------------
- (void)insertText:(id)string replacementRange:(NSRange)replacementRange {
    (void)replacementRange;
    NSString *text = [string isKindOfClass:[NSAttributedString class]]
        ? [(NSAttributedString *)string string]
        : (NSString *)string;
    if (![text isKindOfClass:[NSString class]] || text.length == 0) return;
    [self unmarkText];
    if (self.collecting) {
        [self.collectedText addObject:text];
    } else if (self.surface) {
        // Caminho direto (insertText fora de keyDown): envia via surface_key com
        // text — mesmo método do caso 1, que renderiza.
        ghostty_input_key_s k;
        memset(&k, 0, sizeof(k));
        k.action = GHOSTTY_ACTION_PRESS;
        k.text = [text UTF8String];
        if (text.length > 0) k.unshifted_codepoint = [text characterAtIndex:0];
        ghostty_surface_key(self.surface, k);
    }
}

- (void)setMarkedText:(id)string
        selectedRange:(NSRange)selectedRange
     replacementRange:(NSRange)replacementRange {
    (void)selectedRange; (void)replacementRange;
    NSString *text = [string isKindOfClass:[NSAttributedString class]]
        ? [(NSAttributedString *)string string]
        : (NSString *)string;
    self.markedText = [text isKindOfClass:[NSString class]] ? text : @"";
    if (self.surface) {
        const char *u = [self.markedText UTF8String];
        ghostty_surface_preedit(self.surface, u, strlen(u));
    }
}

- (void)unmarkText {
    if (self.markedText.length == 0) return;
    self.markedText = @"";
    if (self.surface) ghostty_surface_preedit(self.surface, "", 0);
}

- (BOOL)hasMarkedText { return self.markedText.length > 0; }
- (NSRange)markedRange {
    return self.markedText.length > 0 ? NSMakeRange(0, self.markedText.length)
                                      : NSMakeRange(NSNotFound, 0);
}
- (NSRange)selectedRange { return NSMakeRange(NSNotFound, 0); }
- (NSAttributedString *)attributedSubstringForProposedRange:(NSRange)range
                                                actualRange:(NSRangePointer)actualRange {
    (void)range; (void)actualRange; return nil;
}
- (NSArray<NSAttributedStringKey> *)validAttributesForMarkedText { return @[]; }
- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actualRange {
    (void)range; (void)actualRange;
    // Posição aproximada do cursor de composição (canto da view). Suficiente
    // para o painel de IME aparecer perto; refinamento fica pra depois.
    NSRect r = NSMakeRect(0, 0, 1, 1);
    NSRect win = [self convertRect:r toView:nil];
    return [self.window convertRectToScreen:win];
}
- (NSUInteger)characterIndexForPoint:(NSPoint)point { (void)point; return NSNotFound; }
- (void)doCommandBySelector:(SEL)selector {
    // AppKit resolve teclas não-texto em comandos de edição (insertNewline: pra
    // Enter, deleteBackward: pra backspace, etc.). Registramos qual foi pra o
    // keyDown saber que NÃO é texto digitável e mandar a tecla crua pro Ghostty
    // — senão o Enter viraria um "\n" inserido em vez de executar o comando.
    self.lastCommand = selector;
}

- (void)keyUp:(NSEvent *)event {
    if (!self.surface) return;
    ghostty_input_key_s key;
    memset(&key, 0, sizeof(key));
    key.action = GHOSTTY_ACTION_RELEASE;
    key.mods = alethe_mods(event.modifierFlags);
    key.keycode = event.keyCode;
    // Mesma correção do keyDown: tecla base sem Ctrl (ver comentário lá).
    NSString *bare = [event charactersByApplyingModifiers:0];
    if (bare.length == 0) bare = event.charactersIgnoringModifiers;
    if (bare.length > 0) key.unshifted_codepoint = [bare characterAtIndex:0];
    ghostty_surface_key(self.surface, key);
}

- (NSPoint)ghosttyPoint:(NSEvent *)event {
    NSPoint p = [self convertPoint:event.locationInWindow fromView:nil];
    // Ghostty espera y crescendo pra baixo a partir do topo da view.
    return NSMakePoint(p.x, self.bounds.size.height - p.y);
}

- (void)mouseDown:(NSEvent *)event {
    if (!self.surface) return;
    [self.window makeFirstResponder:self];
    NSPoint p = [self ghosttyPoint:event];
    ghostty_surface_mouse_pos(self.surface, p.x, p.y, alethe_mods(event.modifierFlags));
    ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_PRESS,
                                 GHOSTTY_MOUSE_LEFT, alethe_mods(event.modifierFlags));
}
- (void)mouseUp:(NSEvent *)event {
    if (!self.surface) return;
    ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_RELEASE,
                                 GHOSTTY_MOUSE_LEFT, alethe_mods(event.modifierFlags));
}
- (void)mouseMoved:(NSEvent *)event   { [self forwardPos:event]; }
- (void)mouseDragged:(NSEvent *)event { [self forwardPos:event]; }
- (void)forwardPos:(NSEvent *)event {
    if (!self.surface) return;
    NSPoint p = [self ghosttyPoint:event];
    ghostty_surface_mouse_pos(self.surface, p.x, p.y, alethe_mods(event.modifierFlags));
}
- (void)scrollWheel:(NSEvent *)event {
    if (!self.surface) return;
    ghostty_surface_mouse_scroll(self.surface, event.scrollingDeltaX,
                                 event.scrollingDeltaY, 0);
}
@end

// ---- API pública ----------------------------------------------------------

bool alethe_ghostty_ensure_app(void) {
    if (g_app != NULL) return true;

    // ghostty_init é global e idempotente do nosso lado (só chamamos quando
    // ainda não há app).
    ghostty_init(0, NULL);

    g_config = ghostty_config_new();
    if (g_config == NULL) return false;
    ghostty_config_finalize(g_config);

    ghostty_runtime_config_s rt;
    memset(&rt, 0, sizeof(rt));
    rt.userdata = NULL;
    rt.supports_selection_clipboard = false;
    rt.wakeup_cb = shim_wakeup_cb;
    rt.action_cb = shim_action_cb;
    rt.read_clipboard_cb = shim_read_clipboard_cb;
    rt.confirm_read_clipboard_cb = shim_confirm_read_clipboard_cb;
    rt.write_clipboard_cb = shim_write_clipboard_cb;
    rt.close_surface_cb = shim_close_surface_cb;

    g_app = ghostty_app_new(&rt, g_config);
    return g_app != NULL;
}

// Monitor local de eventos para atalhos Cmd+X quando o terminal está focado.
// Na janela do Tauri, a WKWebView (irmã da nossa view, anterior na hierarquia)
// e o menu do app capturam key-equivalents ANTES da varredura chegar à nossa
// view — o performKeyEquivalent: dela nunca roda e Cmd+V morre no WebView. O
// monitor local roda antes de todo o despacho (sendEvent/menu/webview): se o
// first responder é um terminal Ghostty e o evento é um keybinding do Ghostty
// (Cmd+V = paste, Cmd+C = copy…), roteia pro keyDown do terminal e consome.
static id g_cmd_key_monitor = nil;

static void alethe_install_cmd_monitor(void) {
    if (g_cmd_key_monitor != nil) return;
    g_cmd_key_monitor = [NSEvent
        addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                     handler:^NSEvent *(NSEvent *event) {
        if (!(event.modifierFlags & NSEventModifierFlagCommand)) return event;
        NSWindow *win = event.window ?: NSApp.keyWindow;
        NSResponder *fr = win.firstResponder;
        if (![fr isKindOfClass:[AletheGhosttyView class]]) return event;
        AletheGhosttyView *v = (AletheGhosttyView *)fr;
        if (!v.surface) return event;

        ghostty_input_key_s key;
        memset(&key, 0, sizeof(key));
        key.action = GHOSTTY_ACTION_PRESS;
        key.mods = alethe_mods(event.modifierFlags);
        key.keycode = event.keyCode;
        NSString *bare = [event charactersByApplyingModifiers:0];
        if (bare.length == 0) bare = event.charactersIgnoringModifiers;
        if (bare.length > 0) key.unshifted_codepoint = [bare characterAtIndex:0];
        NSEventModifierFlags consumed = event.modifierFlags &
            ~(NSEventModifierFlagControl | NSEventModifierFlagCommand);
        key.consumed_mods = alethe_mods(consumed);
        NSString *chars = event.characters;
        key.text = chars.length > 0 ? [chars UTF8String] : NULL;

        ghostty_binding_flags_e flags = 0;
        if (!ghostty_surface_key_is_binding(v.surface, key, &flags)) {
            return event; // não é atalho do terminal: segue o fluxo normal do app
        }
        [v keyDown:event];
        return nil; // consumido pelo terminal
    }];
}

alethe_surface_t alethe_ghostty_surface_new(void *superview,
                                            const char *cwd,
                                            const char *command,
                                            double scale_factor) {
    if (!alethe_ghostty_ensure_app()) return NULL;
    if (superview == NULL) return NULL;

    // Cria a NSView customizada que recebe input e hospeda a surface, e a anexa
    // à superview (content view da janela do Tauri) fornecida pelo Rust.
    NSView *parent = (__bridge NSView *)superview;
    AletheGhosttyView *view = [[AletheGhosttyView alloc] initWithFrame:parent.bounds];
    view.wantsLayer = YES;
    [parent addSubview:view];
    alethe_install_cmd_monitor();

    ghostty_surface_config_s cfg = ghostty_surface_config_new();
    cfg.platform_tag = GHOSTTY_PLATFORM_MACOS;
    cfg.platform.macos.nsview = (__bridge void *)view;
    // userdata = a view dona: os callbacks de clipboard usam isto pra achar a
    // surface e completar o paste (Cmd+V). NULL aqui = paste morto.
    cfg.userdata = (__bridge void *)view;
    cfg.backend = GHOSTTY_SURFACE_IO_BACKEND_EXEC;
    cfg.context = GHOSTTY_SURFACE_CONTEXT_WINDOW;
    cfg.scale_factor = scale_factor > 0 ? scale_factor : 2.0;
    if (cwd != NULL && cwd[0] != '\0') cfg.working_directory = cwd;
    if (command != NULL && command[0] != '\0') cfg.command = command;

    ghostty_surface_t surface = ghostty_surface_new(g_app, &cfg);
    if (surface == NULL) {
        [view removeFromSuperview];
        return NULL;
    }
    view.surface = surface;
    alethe_register_surface(surface, view);

    // NÃO roubamos o first-responder na criação. Se cada surface criada virasse
    // first-responder, a ÚLTIMA criada (inclusive surfaces órfãs de reload/troca
    // de projeto) engoliria todo o teclado, enquanto a surface visível não
    // receberia input — exatamente o bug "digito e nada aparece". O foco passa a
    // vir do clique (mouseDown) ou de um focus explícito do app.
    return (alethe_surface_t)surface;
}

// Resolve o userdata da surface (a AletheGhosttyView dona) de volta pra
// surface. Usado pelos callbacks de clipboard — ver forward declaration.
static ghostty_surface_t alethe_surface_for_userdata(void *userdata) {
    if (userdata == NULL) return NULL;
    AletheGhosttyView *v = (__bridge AletheGhosttyView *)userdata;
    return v.surface;
}

// Recupera a AletheGhosttyView associada a uma surface (busca no registro).
static AletheGhosttyView *alethe_view_for_surface(ghostty_surface_t s) {
    for (int i = 0; i < g_surface_count; i++) {
        if (g_surfaces[i] == s) return g_views[i];
    }
    return nil;
}

// Posiciona a NSView (em pontos AppKit, origem inferior-esquerda) — chamado pelo
// Rust no sync_frame. Mantém a view alinhada ao placeholder do DOM.
void alethe_ghostty_surface_set_frame(alethe_surface_t surface,
                                      double x, double y,
                                      double w, double h) {
    if (surface == NULL) return;
    AletheGhosttyView *v = alethe_view_for_surface((ghostty_surface_t)surface);
    if (v) v.frame = NSMakeRect(x, y, w < 1 ? 1 : w, h < 1 ? 1 : h);
}

void alethe_ghostty_surface_set_hidden(alethe_surface_t surface, bool hidden) {
    if (surface == NULL) return;
    AletheGhosttyView *v = alethe_view_for_surface((ghostty_surface_t)surface);
    if (v) v.hidden = hidden;
}

void alethe_ghostty_surface_set_size(alethe_surface_t surface,
                                     unsigned int width_px,
                                     unsigned int height_px) {
    if (surface == NULL) return;
    ghostty_surface_set_size((ghostty_surface_t)surface,
                             (uint32_t)width_px, (uint32_t)height_px);
}

void alethe_ghostty_surface_set_content_scale(alethe_surface_t surface,
                                              double x, double y) {
    if (surface == NULL) return;
    ghostty_surface_set_content_scale((ghostty_surface_t)surface, x, y);
}

void alethe_ghostty_surface_set_focus(alethe_surface_t surface, bool focused) {
    if (surface == NULL) return;
    ghostty_surface_set_focus((ghostty_surface_t)surface, focused);
}

void alethe_ghostty_surface_draw(alethe_surface_t surface) {
    if (surface == NULL) return;
    alethe_draw_surface((ghostty_surface_t)surface);
}

// true quando o processo do terminal (shell/agente) já terminou — o Ghostty
// mostra "Press any key to close", mas cabe ao app fechar o pane. Consultado por
// polling do frontend (ghostty_surface_exited) para reajustar o layout.
bool alethe_ghostty_surface_process_exited(alethe_surface_t surface) {
    if (surface == NULL) return false;
    return ghostty_surface_process_exited((ghostty_surface_t)surface);
}

unsigned long long alethe_ghostty_draw_count(void) {
    return g_draw_count;
}

bool alethe_ghostty_test_type_key(alethe_surface_t surface,
                                  const char *characters,
                                  unsigned short keycode) {
    if (surface == NULL || characters == NULL) return false;
    AletheGhosttyView *v = alethe_view_for_surface((ghostty_surface_t)surface);
    if (v == nil) return false;
    NSString *chars = [NSString stringWithUTF8String:characters];
    NSEvent *e = [NSEvent keyEventWithType:NSEventTypeKeyDown
                                  location:NSZeroPoint
                             modifierFlags:0
                                 timestamp:0
                              windowNumber:0
                                   context:nil
                                characters:chars
               charactersIgnoringModifiers:chars
                                 isARepeat:NO
                                   keyCode:keycode];
    // Caminho REAL: o mesmo keyDown: que o teclado dispara (com UCKeyTranslate).
    [v keyDown:e];
    return true;
}

const char *alethe_ghostty_test_last_key_text(void) {
    return g_last_key_text;
}
bool alethe_ghostty_test_last_key_composing(void) {
    return g_last_key_composing;
}

bool alethe_ghostty_test_ime_compose(alethe_surface_t surface,
                                     const char *marked,
                                     const char *final) {
    if (surface == NULL) return false;
    AletheGhosttyView *v = alethe_view_for_surface((ghostty_surface_t)surface);
    if (v == nil) return false;
    // Simula a composição como o macOS faz: primeiro marca o acento morto, depois
    // insere o caractere composto final — passando pelo MESMO NSTextInputClient
    // que o teclado real usa.
    if (marked && marked[0] != '\0') {
        NSString *m = [NSString stringWithUTF8String:marked];
        [v setMarkedText:m selectedRange:NSMakeRange(0, m.length) replacementRange:NSMakeRange(NSNotFound, 0)];
    }
    if (final && final[0] != '\0') {
        NSString *f = [NSString stringWithUTF8String:final];
        [v insertText:f replacementRange:NSMakeRange(NSNotFound, 0)];
    }
    return true;
}

void alethe_ghostty_surface_free(alethe_surface_t surface) {
    if (surface == NULL) return;
    AletheGhosttyView *v = alethe_view_for_surface((ghostty_surface_t)surface);
    alethe_unregister_surface((ghostty_surface_t)surface);
    ghostty_surface_free((ghostty_surface_t)surface);
    [v removeFromSuperview];
}

// Mata TODAS as surfaces vivas. Chamado no boot do frontend para limpar
// surfaces órfãs que sobreviveram a um reload da WebView (o JS é recriado mas as
// NSViews/o app Ghostty persistem). Sem isso, surfaces antigas ficam empilhadas
// e roubam foco/atrapalham o render. Main thread.
void alethe_ghostty_kill_all(void) {
    while (g_surface_count > 0) {
        ghostty_surface_t s = g_surfaces[0];
        AletheGhosttyView *v = g_views[0];
        alethe_unregister_surface(s);
        if (s) ghostty_surface_free(s);
        [v removeFromSuperview];
    }
    fprintf(stderr, "[alethe-diag] kill_all -> count=%d\n", g_surface_count);
}

void alethe_ghostty_app_tick(void) {
    if (g_app) ghostty_app_tick(g_app);
}

void alethe_ghostty_surface_send_text(alethe_surface_t surface,
                                      const char *utf8,
                                      size_t len) {
    if (surface == NULL || utf8 == NULL || len == 0) return;
    ghostty_surface_text((ghostty_surface_t)surface, utf8, (uintptr_t)len);
}

size_t alethe_ghostty_surface_read_screen(alethe_surface_t surface,
                                          char *out,
                                          size_t cap) {
    if (surface == NULL || out == NULL || cap == 0) return 0;
    out[0] = '\0';

    // Seleção cobrindo o viewport inteiro: do topo-esquerda ao baixo-direita.
    ghostty_selection_s sel;
    memset(&sel, 0, sizeof(sel));
    sel.top_left.tag = GHOSTTY_POINT_VIEWPORT;
    sel.top_left.coord = GHOSTTY_POINT_COORD_TOP_LEFT;
    sel.top_left.x = 0;
    sel.top_left.y = 0;
    sel.bottom_right.tag = GHOSTTY_POINT_VIEWPORT;
    sel.bottom_right.coord = GHOSTTY_POINT_COORD_BOTTOM_RIGHT;
    sel.bottom_right.x = 0;
    sel.bottom_right.y = 0;
    sel.rectangle = false;

    ghostty_text_s text;
    memset(&text, 0, sizeof(text));
    if (!ghostty_surface_read_text((ghostty_surface_t)surface, sel, &text)) {
        return 0;
    }
    size_t n = 0;
    if (text.text != NULL && text.text_len > 0) {
        n = (size_t)text.text_len;
        if (n >= cap) n = cap - 1;
        memcpy(out, text.text, n);
        out[n] = '\0';
    }
    ghostty_surface_free_text((ghostty_surface_t)surface, &text);
    return n;
}
