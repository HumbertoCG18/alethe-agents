use portable_pty::{native_pty_system, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

use crate::cli_resolver::{command_builder_for_terminal, find_windows_cli_launcher};
use crate::diagnostics::append_spawn_log;
use crate::paths::{scrollback_dir, scrollback_path};
use crate::process_tree;
use crate::provider_common::now_ms;

pub const SCROLLBACK_CAP_BYTES: usize = 4 * 1024 * 1024;
pub const SCROLLBACK_FLUSH_INTERVAL_MS: u128 = 250;

/// `SCROLLBACK_CAP_BYTES`. 2× o cap = ~2× de write-amplification amortizada
/// Acima disso o `.bin` (append-only) é compactado pra cauda de
/// `SCROLLBACK_CAP_BYTES`. 2× o cap = ~2× de write-amplification amortizada
/// sobre a saída real, e no máximo ~8 MB por terminal em disco.
pub const SCROLLBACK_COMPACT_BYTES: u64 = SCROLLBACK_CAP_BYTES as u64 * 2;
/// Cadência do canal `pty://activity/{id}` enquanto o painel está invisível —
/// baixa o suficiente pra não pesar na main thread do webview, alta o
/// suficiente pra `AgentCompletionMonitor` (RESPONSE_IDLE_MS=4500 no frontend)
/// detectar "agente terminou" com folga mesmo em background.
pub const PTY_ACTIVITY_EMIT_INTERVAL_MS: u128 = 450;
const TEARDOWN_NORMAL: u8 = 0;
const TEARDOWN_KILLED: u8 = 1;
const TEARDOWN_SUSPENDED: u8 = 2;
const TEARDOWN_RESTARTED: u8 = 3;
const CHILD_EXIT_POLL_MS: u64 = 150;
const CHILD_EXIT_GRACE_MS: u128 = 500;

fn watcher_should_close(child_exited: bool, elapsed_since_exit_ms: u128) -> bool {
    child_exited && elapsed_since_exit_ms >= CHILD_EXIT_GRACE_MS
}

fn exit_reason(teardown: u8) -> &'static str {
    match teardown {
        TEARDOWN_KILLED => "killed",
        TEARDOWN_SUSPENDED => "suspended",
        TEARDOWN_RESTARTED => "restarted",
        _ => "exited",
    }
}

fn child_has_exited(child: &Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>) -> bool {
    match child.lock() {
        Ok(mut child) => child
            .try_wait()
            .map(|status| status.is_some())
            .unwrap_or(true),
        Err(_) => true,
    }
}

/// RAM livre mínima (do SISTEMA, não só do que o Alethe gerencia) exigida
/// antes de tentar o boot de um agente novo. Sem isso, um boot com o sistema
/// já no limite deixa o PRÓPRIO processo do agente (Node/WebKit/etc.) nascer
/// sem memória suficiente e se matar sozinho assim que tenta alocar (visto ao
/// vivo: crash "MemoryExhaustion" do JavaScriptCore) — algo que o Alethe não
/// tem como evitar DEPOIS que o processo já nasceu, porque não controla o
/// alocador interno dele. O `ResourceSupervisor` (resources.rs) só enxerga a
/// memória dos processos que o próprio Alethe já gerencia, não a RAM livre
/// real do Windows — por isso esse gate é separado e roda sempre, mesmo com o
/// supervisor no modo manual.
const SPAWN_MIN_AVAILABLE_MB: f64 = 400.0;
const SPAWN_MEMORY_WAIT_POLL_MS: u64 = 1_000;
/// Teto de espera: depois disso tenta o boot mesmo sem folga confirmada — é
/// melhor arriscar um crash raro do que travar o usuário pra sempre esperando
/// uma liberação de RAM que pode nunca vir (ex.: outro processo com vazamento
/// real, não uma pressão passageira).
const SPAWN_MEMORY_WAIT_MAX_MS: u128 = 45_000;

#[derive(Clone, Serialize)]
pub struct PtySpawnMemoryWaitPayload {
    pub available_mb: f64,
    pub waited_ms: u128,
    pub threshold_mb: f64,
}

/// Espera a RAM livre do sistema ter uma folga mínima antes de deixar o
/// chamador prosseguir com o boot real do processo. Depois que o agente já
/// nasceu com folga, o consumo contínuo dele é responsabilidade do próprio
/// provider (Claude/Codex/OpenCode já gerenciam sua própria memória em
/// runtime) — este gate protege só o MOMENTO do boot, nunca o funcionamento
/// depois.
fn wait_for_spawnable_memory(app: &AppHandle, id: &str) -> u128 {
    let started = Instant::now();
    loop {
        let available_mb = crate::stats::memory_stats_cached().system_available_mb;
        if available_mb >= SPAWN_MIN_AVAILABLE_MB {
            return started.elapsed().as_millis();
        }
        let waited_ms = started.elapsed().as_millis();
        let _ = app.emit(
            &format!("pty://spawn-wait/{id}"),
            PtySpawnMemoryWaitPayload {
                available_mb,
                waited_ms,
                threshold_mb: SPAWN_MIN_AVAILABLE_MB,
            },
        );
        if waited_ms >= SPAWN_MEMORY_WAIT_MAX_MS {
            return waited_ms;
        }
        thread::sleep(Duration::from_millis(SPAWN_MEMORY_WAIT_POLL_MS));
    }
}

// (~5.8 GB de folga) enquanto a RAM "livre" parecia OK. Comprometer de

// DESATIVADO (não removido, pra não perder o raciocínio): a ideia original
// era um "colchão" de RAM que o Alethe ia comprometendo aos poucos em segundo
// plano (só quando sobrava RAM FÍSICA livre) e soltava bem antes de cada
// boot, pra aumentar a chance da memória recém-liberada ir pro processo
// novo. Descartada depois de um crash real ao vivo: `sysinfo::available_memory()`
// só enxerga RAM física livre, nunca o LIMITE DE COMMIT do Windows (RAM +
// paginação somados) — e nesse teste o commit já estava em 39.7 de 45.5 GB
// (~5.8 GB de folga) enquanto a RAM "livre" parecia OK. Comprometer de
// propósito até 400 MB extras num sistema já perto do limite de commit é
// exatamente o tipo de coisa que pode estourar esse limite e causar um crash
// pior do que o que o mecanismo tentava evitar — o oposto da intenção. Uma
// versão futura precisaria checar o commit real (`GetPerformanceInfo` do
// Windows, via a crate `windows`) antes de comprometer qualquer coisa, não
// só a RAM física. Até lá, `wait_for_spawnable_memory` sozinha é a escolha
// seguro: só LÊ o estado, nunca aloca nada de propósito.
fn prepare_memory_for_boot(app: &AppHandle, id: &str) -> u128 {
    wait_for_spawnable_memory(app, id)
}

pub struct ScrollbackBuffer {
    pub data: VecDeque<u8>,
    pub last_flush: Instant,
    pub dirty: bool,
    /// Bytes novos ainda não escritos em disco. O flush faz APPEND só disto —
    /// não reescreve os 4 MB do anel. Sem isso, um spinner (poucos bytes/s)
    /// forçava um rewrite de 4 MB a cada 250ms (~16 MB/s por terminal ativo).
    pub pending: Vec<u8>,
}

impl ScrollbackBuffer {
    pub fn new(initial: VecDeque<u8>) -> Self {
        Self {
            data: initial,
            last_flush: Instant::now(),
            dirty: false,
            pending: Vec::new(),
        }
    }
}

/// a cauda de um caractere multibyte que o `read()` do PTY partiu no limite do

/// Quantos bytes do início de `buf` formam UTF-8 válido. O resto (0–3 bytes) é
/// a cauda de um caractere multibyte que o `read()` do PTY partiu no limite do
/// buffer — esses bytes esperam a próxima leitura pra não virarem `�`.
fn valid_utf8_prefix_len(buf: &[u8]) -> usize {
    match std::str::from_utf8(buf) {
        Ok(s) => s.len(),
        Err(error) => error.valid_up_to(),
    }
}

/// Avança `start` até o próximo byte que inicia um caractere UTF-8 (ou até o
/// fim do slice), evitando cortar no meio de uma sequência multibyte quando
/// `start` foi escolhido só por contagem de bytes (ex.: truncar scrollback
/// pelos últimos N bytes em `attach_pty`). Bytes de continuação UTF-8 sempre
/// têm os dois bits mais altos como `10`; sem isso, um corte no meio de um
/// acento (ex.: "ã" = 2 bytes) sobra um byte órfão que vira `U+FFFD` no
/// `from_utf8_lossy` seguinte.
pub(crate) fn align_to_char_boundary(slice: &[u8], start: usize) -> usize {
    let mut start = start.min(slice.len());
    while start < slice.len() && (slice[start] & 0xC0) == 0x80 {
        start += 1;
    }
    start
}

/// output real → resize → nudge de redesenho) em `spawn.log`, pro

/// `ALETHE_PTY_DEBUG=1` liga uma timeline de timestamps (spawn → primeiro
/// output real → resize → nudge de redesenho) em `spawn.log`, pro
/// procedimento de diagnóstico da área principal do OpenCode renderizando
/// em branco (ver docs/CHANGELOG.md e o plano de investigação). Mesmo
/// padrão de `ALETHE_E2E`/`ALETHE_GHOSTTY_PROBE` já usado no projeto — sem
/// a variável, zero custo extra (só a checagem do env var).
fn pty_debug_enabled() -> bool {
    std::env::var("ALETHE_PTY_DEBUG").as_deref() == Ok("1")
}

/// Decide se o canal `pty://activity/{id}` (painel invisível) já pode emitir
/// de novo. `None` = nunca emitiu ainda (primeiro lote invisível passa na
/// hora, sem esperar o intervalo).
fn activity_emit_due(last_activity_emit: Option<Instant>, interval_ms: u128) -> bool {
    match last_activity_emit {
        None => true,
        Some(last) => last.elapsed().as_millis() >= interval_ms,
    }
}

pub struct PtySession {
    pub pty_id: String,
    // Arc<Mutex> pelo mesmo motivo do writer (comentário abaixo): resize_pty
    // precisa poder clonar o handle e soltar o lock global de sessions antes
    // de chamar master.resize (ConPTY pode travar) sem prender kill/write/
    // attach de todos os outros PTYs atrás dele.
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    // writer fica em Arc<Mutex> pra write_pty poder soltar o lock global de
    // sessions antes de escrever. Sem isso, escritas longas de um PTY bloqueiam
    // qualquer outra operacao (resize, attach, kill) em todos os outros PTYs.
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    pub scrollback: Arc<Mutex<ScrollbackBuffer>>,
    /// Sinaliza que o reader terminou de persistir a cauda final. Suspensão
    /// espera esta barreira antes de permitir que o mesmo id seja retomado.
    pub reader_done: Arc<(Mutex<Option<bool>>, Condvar)>,
    /// Motivo do teardown. Kill/restart pulam o flush final; suspend espera o
    /// flush final do reader antes de permitir a retomada do mesmo `ptyId`.
    pub teardown: Arc<AtomicU8>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub read_active: Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
    /// Visibilidade lógica do painel no frontend (aba/grupo ativo, não
    /// colapsado). NÃO pausa a leitura do PTY (isso travaria o `write()` do
    /// agente) — só decide se o coalescer manda o lote pro canal `data`
    /// (render caro) ou pro `activity` (throttlado, só recordIo/completion).
    pub visible: Arc<AtomicBool>,

    /// OpenCode, disparado tanto no boot (primeiro output real do processo)
    /// quanto em `resize_pty`. Os dois gatilhos podem cair quase juntos —
    /// Timestamp (ms) do último nudge de redesenho (Ctrl+L) mandado pro
    /// OpenCode, disparado tanto no boot (primeiro output real do processo)
    /// quanto em `resize_pty`. Os dois gatilhos podem cair quase juntos —
    /// sem coordenação, dois redesenhos concorrentes do OpenCode se
    /// sobrepunham na tela em vez de um substituir o outro (texto/blocos de
    /// um redraw colidindo com o outro), confirmado analisando os bytes
    /// crus do scrollback. `try_claim_opencode_nudge` garante só um disparo
    /// por janela curta, não importa qual dos dois gatilhos chegou primeiro.
    pub opencode_nudge_lock: Arc<AtomicU64>,
}

const OPENCODE_NUDGE_COOLDOWN_MS: u64 = 400;

/// CAS simples: só concede o nudge se a última tentativa (de QUALQUER
/// gatilho) foi há mais de `OPENCODE_NUDGE_COOLDOWN_MS`. `Ordering::SeqCst`
/// por segurança — não é um caminho quente o suficiente pra valer a pena
/// relaxar.
fn try_claim_opencode_nudge(lock: &AtomicU64) -> bool {
    let now = now_ms();
    let last = lock.load(Ordering::SeqCst);
    if now.saturating_sub(last) < OPENCODE_NUDGE_COOLDOWN_MS {
        return false;
    }
    lock.compare_exchange(last, now, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

pub type PtySessions = Arc<Mutex<HashMap<String, PtySession>>>;

#[cfg(windows)]
static PTY_JOB_HANDLE: OnceLock<isize> = OnceLock::new();

/// Coordena somente spawns do MESMO id. O mutex de `PtySessions` não pode
/// permanecer travado durante `openpty`/resolução/spawn do processo: isso
/// serializava todos os terminais apesar da fila do frontend permitir paralelismo.
static SPAWN_COORDINATOR: OnceLock<(Mutex<HashSet<String>>, Condvar)> = OnceLock::new();

struct SpawnReservation {
    id: String,
}

impl Drop for SpawnReservation {
    fn drop(&mut self) {
        let (spawning, ready) =
            SPAWN_COORDINATOR.get_or_init(|| (Mutex::new(HashSet::new()), Condvar::new()));
        if let Ok(mut ids) = spawning.lock() {
            ids.remove(&self.id);
            ready.notify_all();
        }
    }
}

fn reserve_spawn(sessions: &PtySessions, id: &str) -> Result<Option<SpawnReservation>, String> {
    let (spawning, ready) =
        SPAWN_COORDINATOR.get_or_init(|| (Mutex::new(HashSet::new()), Condvar::new()));
    let mut ids = spawning
        .lock()
        .map_err(|_| "PTY spawn coordinator lock poisoned".to_string())?;

    loop {
        let already_spawned = sessions
            .lock()
            .map_err(|_| "PTY sessions lock poisoned".to_string())?
            .contains_key(id);
        if already_spawned {
            return Ok(None);
        }
        if ids.insert(id.to_string()) {
            return Ok(Some(SpawnReservation { id: id.to_string() }));
        }
        ids = ready
            .wait(ids)
            .map_err(|_| "PTY spawn coordinator wait poisoned".to_string())?;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnPtyResponse {
    pub id: String,
    /// A plain shell's own shell no longer runs, so the default one took its place.
    pub shell_fallback: bool,
}

#[derive(Clone, Serialize)]
pub struct PtyExitPayload {
    pub code: Option<i32>,
    pub reason: &'static str,
}

#[derive(Clone, Serialize)]
pub struct PtySuspendedPayload {
    pub id: String,
    pub reason: &'static str,
}

#[derive(Serialize)]
pub struct PtyProcessSnapshot {
    pub id: String,
    pub pid: Option<u32>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub process_name: Option<String>,
    pub cmdline: Option<String>,
    pub memory_mb: f64,
    pub alive: bool,
}

#[tauri::command]
pub fn pty_exists(sessions: State<'_, PtySessions>, id: String) -> Result<bool, String> {
    let sessions = sessions
        .lock()
        .map_err(|_| "PTY sessions lock poisoned".to_string())?;
    Ok(sessions.contains_key(&id))
}

/// What a tab launches: its override, else the fallback, when that is an absolute file (a plain
/// tab's own shell, then the default from Preferences; or an agent's CLI path), else the agent CLI
/// found on PATH. Both come from editable app data, so they pass the default shell's check. The
/// flag says a plain shell's own shell was given but no longer runs.
fn resolve_launcher(
    launcher_override: Option<&str>,
    fallback_launcher: Option<&str>,
    requested_command: Option<&str>,
) -> (Option<String>, bool) {
    let (shell, fell_back) =
        crate::terminal_settings::pick_shell(launcher_override, fallback_launcher);
    let launcher = shell.or_else(|| {
        let command = requested_command?.trim();
        if command.is_empty() {
            return None;
        }
        find_windows_cli_launcher(command).map(|path| path.to_string_lossy().to_string())
    });
    // An agent's override is its CLI path, not a shell of the tab's own.
    (launcher, fell_back && requested_command.is_none())
}

#[tauri::command]
pub async fn spawn_pty(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    remote: State<'_, Arc<crate::remote::RemoteHub>>,
    cols: u16,
    rows: u16,
    id: Option<String>,
    command: Option<String>,
    cwd: Option<String>,
    extra_args: Option<Vec<String>>,
    // Absolute launcher paths that supersede auto-detect, in this order; see `resolve_launcher`.
    launcher_override: Option<String>,
    fallback_launcher: Option<String>,
    // Extra environment for this terminal only, never the global one or other terminals'.
    env: Option<std::collections::HashMap<String, String>>,
    // Set only by orchestrator shells: the line the shell runs and exits with.
    command_line: Option<String>,
) -> Result<SpawnPtyResponse, String> {
    // OUTRO comando IPC (spawn de outro terminal, poll do GSD Sync, leitura de
    // `openpty`/resolução do launcher/`spawn_command` são chamadas de SO de
    // verdade (ConPTY, criação de processo) — podem demorar bem mais que o
    // normal sob AV/antivírus escaneando o processo novo, ou travar de vez em
    // quando (bug conhecido do ConPTY do Windows). Antes disso rodava direto
    // na thread que o Tauri usa pra despachar o comando; se travasse, TODO
    // OUTRO comando IPC (spawn de outro terminal, poll do GSD Sync, leitura de
    // PTYs já abertos) ficava esperando atrás dele — o app inteiro parecia
    // travado, não só o terminal novo. `spawn_blocking` isola isso na thread
    // pool bloqueante dedicada do Tokio (até 512 threads), mesmo padrão já
    // usado em todo outro comando pesado deste codebase (ver `claude_sessions`,
    // `activity_stats`, `agent_cost`).
    let sessions: PtySessions = Arc::clone(sessions.inner());
    let remote_hub = Arc::clone(remote.inner());
    tokio::task::spawn_blocking(move || {
        let extras: Vec<String> = extra_args.unwrap_or_default();
        let spawn_started = Instant::now();
        let id = id.unwrap_or_else(|| nanoid::nanoid!());
        let requested_command = command.clone();
        // First step: the folder is resolved, checked and held as starting before the memory wait,
        // and stays held until the session is registered or the spawn fails.
        let Some(begun) = begin_pty_spawn(&sessions, &id, cwd.as_deref(), || {
            // Boot de verdade vai acontecer — solta o colchão pré-alocado e
            // garante folga de RAM antes de criar o processo (ver comentário de
            // `prepare_memory_for_boot`).
            prepare_memory_for_boot(&app, &id)
        })?
        else {
            return Ok(SpawnPtyResponse {
                id,
                shell_fallback: false,
            });
        };
        let memory_wait_ms = begun.memory_wait_ms;

        let scrollback = Arc::new(Mutex::new(ScrollbackBuffer::new(load_scrollback(
            &app, &id,
        )?)));
        let teardown = Arc::new(AtomicU8::new(TEARDOWN_NORMAL));
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())?;

        let resolve_started = Instant::now();
        let wsl_target = if cfg!(windows) {
            cwd.as_deref().and_then(crate::wsl::wsl_target)
        } else {
            None
        };
        let mut resolved_launcher: Option<String> = None;
        // A WSL folder opens the distro's shell, so no shell of the tab's own is skipped there.
        let mut shell_fallback = false;
        let mut command = if let Some(target) = wsl_target.as_ref() {
            crate::wsl::command_builder_for_wsl(
                target,
                requested_command.as_deref(),
                &extras,
                env.as_ref(),
                command_line.as_deref(),
            )
        } else {
            (resolved_launcher, shell_fallback) = resolve_launcher(
                launcher_override.as_deref(),
                fallback_launcher.as_deref(),
                requested_command.as_deref(),
            );
            let mut command = command_builder_for_terminal(
                requested_command.as_deref(),
                resolved_launcher.as_deref(),
                &extras,
                command_line.as_deref(),
            );
            if let Some(extra_env) = env.as_ref() {
                for (key, value) in extra_env {
                    command.env(key, value);
                }
            }
            command
        };
        let resolve_ms = resolve_started.elapsed().as_millis();
        let builder_ms = spawn_started.elapsed().as_millis();
        let effective_path_preview = command
            .get_env("Path")
            .or_else(|| command.get_env("PATH"))
            .map(|value| {
                let s = value.to_string_lossy();
                let limit = s.len().min(240);
                s[..limit].to_string()
            })
            .unwrap_or_else(|| "<none>".to_string());
        if let Some(folder) = begun.folder.as_deref() {
            // Alguns caminhos chegam aqui com o prefixo verbatim `\\?\` do
            // Windows (worktree canonicalizado, dado antigo persistido antes
            // do fix em `worktrees::git_arg` etc.) — `cmd.exe` e vários CLIs
            // baseados em Node recusam esse formato como diretório atual e
            // silenciosamente caem pra `C:\Windows`. Strip aqui é a rede de
            // segurança final: cobre qualquer cwd que chegue sujo, de
            // qualquer origem, sem precisar caçar cada call site.
            command.cwd(crate::worktrees::git_arg(folder));
        }
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| error.to_string())?;
        let shell_spawn_ms = spawn_started.elapsed().as_millis();
        let child = Arc::new(Mutex::new(child));
        let child_pid = child.lock().ok().and_then(|child| child.process_id());
        if let Some(pid) = child_pid {
            process_tree::register_pty_root(&id, pid);
        }
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let writer = Arc::new(Mutex::new(
            pair.master
                .take_writer()
                .map_err(|error| error.to_string())?,
        ));
        let opencode_nudge_lock = Arc::new(AtomicU64::new(0));
        // Nudge de boot (ver uso mais abaixo, no loop de batches): o Ctrl+L




        // OpenCode terminar de subir e trocar o TTY pro modo raw/alt-screen
        // Nudge de boot (ver uso mais abaixo, no loop de batches): o Ctrl+L
        // que já mandamos em `resize_pty` pro OpenCode não cobre o caso de
        // um terminal recém-criado que nunca é redimensionado — o "kick"
        // daquele fix é disparado pelo spawn da promise no frontend, não por
        // sinal nenhum do processo filho, então quase sempre chega ANTES do
        // OpenCode terminar de subir e trocar o TTY pro modo raw/alt-screen
        // da TUI (aterrissa em stdin ainda em modo cooked/pré-boot). Sem
        // nenhum retry, essa única tentativa mal-cronometrada é a única
        // chance que o OpenCode tem — daí a tela ficar em branco/com blocos
        // de glifo soltos mesmo num terminal novo, sem nenhum resize.
        let is_opencode = requested_command.as_deref() == Some("opencode");
        let boot_nudge_writer = Arc::clone(&writer);
        let boot_nudge_lock = Arc::clone(&opencode_nudge_lock);


        // do OpenCode em branco, docs/CHANGELOG.md), separado de `event_app`
        // Handle dedicado pro log de diagnóstico (ver `pty_debug_enabled` /
        // `ALETHE_PTY_DEBUG` — procedimento de diagnóstico da área principal
        // do OpenCode em branco, docs/CHANGELOG.md), separado de `event_app`
        // (canal de dados) só pra deixar claro o propósito em cada clone.
        let debug_app = app.clone();
        let debug_id = id.clone();
        let event_name = format!("pty://data/{id}");
        let activity_event_name = format!("pty://activity/{id}");
        let exit_event_name = format!("pty://exit/{id}");
        let event_app = app.clone();
        let scrollback_app = app.clone();
        let scrollback_id = id.clone();
        let thread_scrollback = Arc::clone(&scrollback);
        let thread_teardown = Arc::clone(&teardown);
        let reader_done = Arc::new((Mutex::new(None), Condvar::new()));
        let thread_reader_done = Arc::clone(&reader_done);
        let thread_child = Arc::clone(&child);
        let thread_sessions = sessions.clone();
        let read_active = Arc::new((std::sync::Mutex::new(true), std::sync::Condvar::new()));
        let thread_read_active = Arc::clone(&read_active);
        let visible = Arc::new(AtomicBool::new(true));
        let thread_visible = Arc::clone(&visible);
        let remote_pty_id = id.clone();



        // de emitir. Resultado: 1 evento IPC + 1 push_scrollback por LOTE em vez de

        // Reader síncrono na thread-pool bloqueante do Tokio manda chunks por um
        // canal MPSC; o batcher async coalesce por até 16ms (60 FPS) ou 64 KB antes
        // de emitir. Resultado: 1 evento IPC + 1 push_scrollback por LOTE em vez de
        // 1 por read — elimina micro-stutters com N terminais em saída pesada.
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(1024);
        let watch_child_exit = wsl_target.is_some();
        let child_gone = Arc::new(tokio::sync::Notify::new());
        if watch_child_exit {
            let watch_child = Arc::clone(&child);
            let watch_signal = Arc::clone(&child_gone);
            thread::spawn(move || {
                let mut exited_at: Option<Instant> = None;
                loop {
                    if exited_at.is_none() && child_has_exited(&watch_child) {
                        exited_at = Some(Instant::now());
                    }
                    let elapsed = exited_at
                        .map(|at| at.elapsed().as_millis())
                        .unwrap_or_default();
                    if watcher_should_close(exited_at.is_some(), elapsed) {
                        watch_signal.notify_one();
                        return;
                    }
                    thread::sleep(Duration::from_millis(CHILD_EXIT_POLL_MS));
                }
            });
        }

        tauri::async_runtime::spawn(async move {
        tokio::task::spawn_blocking(move || {
            // 32 KiB: menos syscalls sob saída pesada (builds, cat de arquivo
            // grande) sem custo de latência pra outputs pequenos.
            let mut buffer = [0_u8; 32 * 1024];
            loop {
                // Checa se leitura está ativa. Se não, bloqueia no Condvar.
                {
                    let (lock, cvar) = &*thread_read_active;
                    let mut active = lock.lock().unwrap();
                    while !*active {
                        active = cvar.wait(active).unwrap();
                    }
                }

                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        if tx.blocking_send(buffer[..count].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Cauda de um caractere UTF-8 multibyte partido entre dois lotes.
        let mut carry: Vec<u8> = Vec::new();
        let mut batch: Vec<u8> = Vec::new();
        // `None` = ainda não emitiu nada no canal `activity` — deixa o
        // primeiro lote invisível passar na hora, sem esperar o intervalo.
        let mut last_activity_emit: Option<Instant> = None;
        // Saída acumulada desde o último emit no canal `activity`, pra o
        // throttle atrasar sem descartar. Teto de 256 KiB porque o consumidor
        // só precisa de volume e de padrões recentes — não redesenha a tela
        // (isso é o replay de scrollback no `doResync`).
        let mut activity_pending = String::new();
        const ACTIVITY_PENDING_CAP: usize = 256 * 1024;







        //
        // O throttle ACUMULA em `activity_pending` em vez de descartar: o


        // amostrar o stream faria um agente em segundo plano nunca sair de

        // Painel visível: emite no canal `data` de sempre (render caro no
        // frontend). Painel invisível: NÃO emite `data` (o frontend não está
        // desenhando aquele xterm mesmo) — emite só `activity`, throttlado,
        // pra manter recordIo/AgentCompletionMonitor vivos em background sem
        // custo de render. `push_scrollback` (fora daqui) roda sempre, então
        // nenhum byte é perdido — só o "desenhar na tela" é adiado.
        //
        // O throttle ACUMULA em `activity_pending` em vez de descartar: o
        // consumidor do canal conta caracteres de saída (`outputChars` do
        // `AgentCompletionMonitor`) e casa padrões de erro de bootstrap, então
        // amostrar o stream faria um agente em segundo plano nunca sair de
        // `armed` ou perder a detecção de conflito de resume do Codex.
        let mut emit_data_or_activity = |text: &str| {



            remote_hub.publish(&remote_pty_id, || {
                serde_json::json!({ "type": "pty_output", "ptyId": &remote_pty_id, "text": text })
            });
            if thread_visible.load(Ordering::Relaxed) {
                if !activity_pending.is_empty() {
                    activity_pending.clear();
                }
                let _ = event_app.emit(&event_name, text);
                return;
            }
            activity_pending.push_str(text);
            if activity_pending.len() > ACTIVITY_PENDING_CAP {
                let drop_to = activity_pending.len() - ACTIVITY_PENDING_CAP;
                let boundary = align_to_char_boundary(activity_pending.as_bytes(), drop_to);
                activity_pending.drain(..boundary);
            }
            if activity_emit_due(last_activity_emit, PTY_ACTIVITY_EMIT_INTERVAL_MS) {
                let _ = event_app.emit(&activity_event_name, activity_pending.as_str());
                activity_pending.clear();
                last_activity_emit = Some(Instant::now());
            }
        };


        let mut sent_boot_nudge = false;

        loop {


            let received = tokio::select! {
                biased;
                chunk = rx.recv() => chunk,
                _ = child_gone.notified() => {
                    let _ = append_spawn_log(
                        &debug_app,
                        &format!(
                            "pty {debug_id}: closed by the child watcher (the pty master never reached EOF)"
                        ),
                    );
                    None
                }
            };
            // Bloqueia até o primeiro chunk — zero wakeups quando o terminal
            // está ocioso. None = reader terminou (EOF/erro) e canal fechou.
            let Some(first) = received else { break };
            batch.extend_from_slice(&first);

            // Primeiro lote real de saída do processo filho = prova de que
            // ele está vivo e já produzindo output — sinal muito mais
            // confiável de "hora certa" do que o momento em que o frontend
            // terminou de esperar o spawn. Kick único, numa task separada
            // pra não atrasar o desenho deste primeiro lote em si.
            if is_opencode && !sent_boot_nudge {
                sent_boot_nudge = true;
                if pty_debug_enabled() {
                    let _ = append_spawn_log(
                        &debug_app,
                        &format!(
                            "[pty-debug] {debug_id}: primeiro batch real recebido ({} bytes)",
                            first.len()
                        ),
                    );
                }
                let nudge_writer = Arc::clone(&boot_nudge_writer);
                let nudge_lock = Arc::clone(&boot_nudge_lock);
                let nudge_debug_app = debug_app.clone();
                let nudge_debug_id = debug_id.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    // Reclama o direito de nudge só na hora de escrever, não
                    // no agendamento — um resize_pty pode ter disparado o
                    // dele durante essa espera; se já ganhou, não manda o
                    // nosso por cima (dois redesenhos concorrentes é o que
                    // causava a corrupção em primeiro lugar).
                    let claimed = try_claim_opencode_nudge(&nudge_lock);
                    if pty_debug_enabled() {
                        let _ = append_spawn_log(
                            &nudge_debug_app,
                            &format!(
                                "[pty-debug] {nudge_debug_id}: nudge de boot {} (150ms após 1º batch)",
                                if claimed { "ENVIADO" } else { "pulado (perdeu a trava)" }
                            ),
                        );
                    }
                    if claimed {
                        if let Ok(mut writer) = nudge_writer.lock() {
                            let _ = writer.write_all(&[12]);
                            let _ = writer.flush();
                        }
                    }
                });
            }

            // Coalesce o que chegar em até 16ms ou até encher 64 KB.
            let batch_started = Instant::now();
            while batch.len() < 64 * 1024 {
                let remaining =
                    Duration::from_millis(16).saturating_sub(batch_started.elapsed());
                if remaining.is_zero() {
                    break;
                }
                match tokio::time::timeout(remaining, rx.recv()).await {
                    Ok(Some(chunk)) => batch.extend_from_slice(&chunk),
                    // None = canal fechou; ainda emitimos o lote acumulado.
                    Ok(None) => break,
                    // Timeout de 16ms estourou.
                    Err(_) => break,
                }
            }

            let count = batch.len();
            // Scrollback recebe os bytes crus do lote (sempre corretos — só o
            // emit precisa de fronteira de caractere).
            let _ = push_scrollback(&scrollback_app, &scrollback_id, &thread_scrollback, &batch);

            // Emit PRIMEIRO o que é UTF-8 completo — user vê o echo na hora,
            // sem disk I/O no caminho da tecla. Caractere partido no limite do
            // lote fica em `carry` pro próximo ciclo.
            if carry.is_empty() {
                // Caminho rápido (caso comum): nada pendente, zero alloc.
                let valid = valid_utf8_prefix_len(&batch);
                if valid > 0 {
                    // SAFETY: batch[..valid] é UTF-8 válido por construção.
                    let text = unsafe { std::str::from_utf8_unchecked(&batch[..valid]) };
                    emit_data_or_activity(text);
                }
                if valid < count {
                    carry.extend_from_slice(&batch[valid..]);
                }
            } else {
                carry.extend_from_slice(&batch);
                let valid = valid_utf8_prefix_len(&carry);
                if valid > 0 {
                    // SAFETY: carry[..valid] é UTF-8 válido por construção.
                    let text = unsafe { std::str::from_utf8_unchecked(&carry[..valid]) };
                    emit_data_or_activity(text);
                    carry.drain(..valid);
                }
            }

            // `carry` só deve guardar a cauda de UM caractere (≤3 bytes).
            // Se passar disso, são bytes inválidos que nunca completam:
            // emite lossy (mostra �) e zera pra não vazar nem travar.
            if carry.len() > 3 {
                let lossy = String::from_utf8_lossy(&carry).into_owned();
                emit_data_or_activity(lossy.as_str());
                carry.clear();
            }

            batch.clear();

            // Backpressure leve pra dar vazão à fila IPC do webview.
            tokio::time::sleep(Duration::from_millis(2)).await;
        }

        // Flush de qualquer cauda restante no fim do stream.
        if !carry.is_empty() {
            let lossy = String::from_utf8_lossy(&carry).into_owned();
            let _ = event_app.emit(&event_name, lossy.as_str());
            remote_hub.publish(&scrollback_id, || {
                serde_json::json!({ "type": "pty_output", "ptyId": &scrollback_id, "text": lossy })
            });
        }




        //

        // PTY morreu: garante o scrollback no disco e LIBERA o buffer em RAM (até
        // 4 MiB). A sessão fica no HashMap; attach_pty recarrega do disco se preciso.
        // Só libera se o flush deu certo, pra nunca perder dados não persistidos.
        //
        // EXCEÇÃO kill/restart (`killed`): NÃO reescreve o .bin. Em kill_pty o
        // delete_scrollback já removeu o arquivo; em restart_pty um novo spawn
        // reusou o mesmo id — em ambos, um Overwrite tardio deste reader morto
        // ressuscitaria/corromperia o arquivo. Aqui só liberamos o buffer em RAM.
        let teardown_reason = thread_teardown.load(Ordering::SeqCst);
        let persisted = if teardown_reason == TEARDOWN_KILLED
            || teardown_reason == TEARDOWN_RESTARTED
        {
            if let Ok(mut buffer) = thread_scrollback.lock() {
                buffer.data = VecDeque::new();
                buffer.pending.clear();
                buffer.dirty = false;
            }
            true
        } else {
            let flushed = flush_scrollback(&scrollback_app, &scrollback_id, &thread_scrollback)
                .and_then(|_| {
                    if teardown_reason == TEARDOWN_SUSPENDED {
                        wait_for_scrollback_writer()
                    } else {
                        Ok(())
                    }
                })
                .is_ok();
            if flushed {
                if let Ok(mut buffer) = thread_scrollback.lock() {
                    buffer.data = VecDeque::new();
                    buffer.dirty = false;
                }
            }
            flushed
        };

        let (done_lock, done_ready) = &*thread_reader_done;
        if let Ok(mut done) = done_lock.lock() {
            *done = Some(persisted);
            done_ready.notify_all();
        }

        let code = thread_child
            .lock()
            .ok()
            .and_then(|mut child| child.wait().ok())
            .map(|status| status.exit_code() as i32);
        let reason = exit_reason(teardown_reason);
        let _ = event_app.emit(&exit_event_name, PtyExitPayload { code, reason });
        remote_hub.publish(&scrollback_id, || {
            serde_json::json!({ "type": "pty_exit", "ptyId": &scrollback_id, "reason": reason })
        });

        if let Some(pid) = child_pid {
            if let Ok(mut sessions) = thread_sessions.lock() {
                let should_remove = sessions
                    .get(&scrollback_id)
                    .and_then(|session| session.child.lock().ok()?.process_id())
                    .map(|current_pid| current_pid == pid)
                    .unwrap_or(false);
                if should_remove {
                    sessions.remove(&scrollback_id);
                }
            }
        }
    });

        let _ = append_spawn_log(
            &app,
            &format!(
                "spawn id={id} command={:?} launcher={:?} wsl_distro={:?} memory_wait_ms={memory_wait_ms} resolve_ms={resolve_ms} builder_ms={builder_ms} shell_spawn_ms={shell_spawn_ms} total_ms={} path_preview={effective_path_preview:?}",
                requested_command,
                resolved_launcher,
                wsl_target.as_ref().map(|target| target.distro.as_str()),
                spawn_started.elapsed().as_millis()
            ),
        );

        let child_for_watch = Arc::clone(&child);
        let session = PtySession {
            pty_id: id.clone(),
            master: Arc::new(Mutex::new(pair.master)),
            writer,
            child,
            scrollback,
            reader_done,
            teardown,
            command: requested_command,
            cwd,
            read_active,
            visible,
            opencode_nudge_lock,
        };

        sessions
            .lock()
            .map_err(|_| "PTY sessions lock poisoned".to_string())?
            .insert(id.clone(), session);

        // A PTY that runs a one-shot line (an installer, an orchestrator shell) is supposed to end
        // with its command — but nothing here would notice. Teardown is only ever started by the
        // app (kill, restart, suspend), and the reader does not reach EOF on its own while this
        // process still holds the master's writer open, so a child that exits by itself leaves the
        // session registered forever and `pty://exit` is never emitted: an install that finished
        // sits on "installing" until the app is restarted. Watching the child closes that gap.
        // Interactive shells keep the old behaviour, since they end only when the app says so.
        if command_line.is_some() {
            let watch_sessions = Arc::clone(&sessions);
            let watch_child = Arc::clone(&child_for_watch);
            let watch_id = id.clone();
            thread::spawn(move || loop {
                thread::sleep(Duration::from_millis(250));
                let exited = watch_child
                    .lock()
                    .ok()
                    .and_then(|mut child| child.try_wait().ok())
                    .flatten()
                    .is_some();
                if !exited {
                    // Someone else (kill, restart) already took the session: stop watching.
                    let known = watch_sessions
                        .lock()
                        .map(|sessions| sessions.contains_key(&watch_id))
                        .unwrap_or(false);
                    if !known {
                        break;
                    }
                    continue;
                }
                // Dropping the session releases the master and its writer, which ends the reader and
                // runs the ordinary teardown: the exit is emitted with its code and reason.
                let session = watch_sessions
                    .lock()
                    .ok()
                    .and_then(|mut sessions| sessions.remove(&watch_id));
                if let Some(session) = session {
                    terminate_session(session);
                }
                break;
            });
        }

        Ok(SpawnPtyResponse { id, shell_fallback })
    })
    .await
    .map_err(|error| format!("spawn_pty: falha na task bloqueante: {error}"))?
}

/// direto (o shell/ConPTY) — `node`/`claude`/`codex` e seus filhos (MCP, workers)

/// Reads the pid, releases the lock, and only then kills the tree.
///
/// `kill_process_tree` runs `taskkill` and waits for it, which under load takes anywhere from
/// hundreds of milliseconds to seconds. Holding the child lock across that stalls the snapshot
/// path, which takes the global session lock before this one — and `write_pty` starts by taking
/// that same global lock, so a single slow kill stops every terminal in the app from accepting a
/// keystroke while output, which never touches the lock, keeps arriving.
fn kill_tree_without_holding_child(child: &Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>) {
    // Scoped so the guard is visibly dropped before the kill, not merely at the end of a line.
    let pid = { child.lock().ok().and_then(|mut child| child.process_id()) };
    if let Some(pid) = pid {
        kill_process_tree(pid);
    }
    if let Ok(mut child) = child.lock() {
        let _ = child.kill();
    }
}

#[cfg(windows)]
pub(crate) fn kill_process_tree(pid: u32) {
    let mut command = std::process::Command::new("taskkill");
    command.args(["/F", "/T", "/PID", &pid.to_string()]);
    crate::git_control::hide_console(&mut command);
    let _ = command.output();
}

/// The `kill(2)` target for the process group led by `pid`. 0 and 1 are refused: as
/// group ids they mean "our own group" and "every process we may signal".
#[cfg(not(windows))]
fn process_group_target(pid: u32) -> Option<i32> {
    i32::try_from(pid)
        .ok()
        .filter(|&pid| pid > 1)
        .map(|pid| -pid)
}

#[cfg(not(windows))]
pub(crate) fn kill_process_tree(pid: u32) {
    // portable-pty calls setsid() on Linux, so the shell owns its own process
    // group. Sending a signal to the negative PID targets the entire group.
    // kill(2) directly, not the `kill` binary: procps reads `kill -TERM -<pid>` as an
    // unknown option and keeps only its first digit, so a PID starting with 1 became
    // `kill(-1)` and signalled every process of the user (#222).
    let Some(group) = process_group_target(pid) else {
        return;
    };
    unsafe { libc::kill(group, libc::SIGTERM) };
    // Give well-behaved processes a moment to exit cleanly, then escalate.
    std::thread::sleep(std::time::Duration::from_millis(200));
    unsafe { libc::kill(group, libc::SIGKILL) };
}

#[tauri::command]
pub async fn restart_pty(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    remote: State<'_, Arc<crate::remote::RemoteHub>>,
    id: String,
    command: Option<String>,
    cwd: Option<String>,
    extra_args: Option<Vec<String>>,
    launcher_override: Option<String>,
    fallback_launcher: Option<String>,
    env: Option<HashMap<String, String>>,
    command_line: Option<String>,
) -> Result<SpawnPtyResponse, String> {
    // apagar o scrollback antigo rodava direto no corpo async, fora de
    // A fase de matar o processo antigo (taskkill pela árvore inteira) +
    // apagar o scrollback antigo rodava direto no corpo async, fora de
    // qualquer spawn_blocking — só o boot do processo NOVO (via spawn_pty,
    // abaixo) estava isolado. Isso travava a thread do runtime Tokio que
    // estava processando este restart, com o mesmo efeito de travar outros
    // comandos IPC atrás dela. Agora a fase de kill também roda em
    // spawn_blocking, e solta o lock de `sessions` assim que remove a sessão
    // do mapa (mesmo motivo de `kill_pty`).
    let kill_sessions: PtySessions = Arc::clone(sessions.inner());
    let kill_app = app.clone();
    let kill_id = id.clone();
    tokio::task::spawn_blocking(move || {
        let session = {
            let mut sessions = kill_sessions
                .lock()
                .map_err(|_| "PTY sessions lock poisoned".to_string())?;
            sessions.remove(&kill_id)
        };
        if let Some(session) = session {
            session.teardown.store(TEARDOWN_RESTARTED, Ordering::SeqCst);
            // `kill_pty_tree` (process_tree.rs) derruba raiz + descendentes em
            // `kill_pty_tree` (process_tree.rs) derruba raiz + descendentes em
            // qualquer plataforma (via sysinfo); precisa rodar ANTES de
            // `kill_process_tree`/`child.kill()` matarem a raiz, senão a
            // travessia da árvore não encontra os netos reparentados.
            let _ = process_tree::kill_pty_tree(&kill_id);
            kill_tree_without_holding_child(&session.child);
        }
        delete_scrollback(&kill_app, &kill_id)
    })
    .await
    .map_err(|error| format!("restart_pty: falha na task bloqueante: {error}"))??;

    spawn_pty(
        app,
        sessions,
        remote,
        80,
        24,
        Some(id),
        command,
        cwd,
        extra_args,
        launcher_override,
        fallback_launcher,
        env,
        command_line,
    )
    .await
}

#[tauri::command]
pub async fn attach_pty(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
    max_bytes: Option<usize>,
) -> Result<String, String> {
    // lento sob um scrollback grande. Igual a `spawn_pty`, roda em
    // Fallback de disco (`load_scrollback`, abaixo) é I/O real — pode ficar
    // lento sob um scrollback grande. Igual a `spawn_pty`, roda em
    // `spawn_blocking` pra não travar o despacho de outros comandos
    // (inclusive o attach de OUTROS terminais) atrás dele; ver comentário
    // completo em `spawn_pty`.
    let sessions: PtySessions = Arc::clone(sessions.inner());
    tokio::task::spawn_blocking(move || {
        let max_bytes = max_bytes.unwrap_or(512 * 1024).max(16 * 1024);

        // Caminho comum: serve do buffer em memória.
        {
            let sessions = sessions
                .lock()
                .map_err(|_| "PTY sessions lock poisoned".to_string())?;
            if let Some(session) = sessions.get(&id) {
                let mut buffer = session
                    .scrollback
                    .lock()
                    .map_err(|_| "PTY scrollback lock poisoned".to_string())?;
                if !buffer.data.is_empty() {
                    // make_contiguous + slice evita a cópia extra do iter().skip().collect().
                    let slice = buffer.data.make_contiguous();
                    let start =
                        align_to_char_boundary(slice, slice.len().saturating_sub(max_bytes));
                    return Ok(String::from_utf8_lossy(&slice[start..]).into_owned());
                }
            }
        }

        // Buffer vazio: PTY recém-criado (sem output) ou PTY morto cujo buffer foi
        // liberado. Em ambos os casos o disco tem a verdade (vazio ou o scrollback final).
        let disk = load_scrollback(&app, &id)?;
        let bytes: Vec<u8> = disk.into_iter().collect();
        let start = align_to_char_boundary(&bytes, bytes.len().saturating_sub(max_bytes));
        Ok(String::from_utf8_lossy(&bytes[start..]).into_owned())
    })
    .await
    .map_err(|error| format!("attach_pty: falha na task bloqueante: {error}"))?
}

#[tauri::command]
pub async fn clear_pty_scrollback(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
) -> Result<(), String> {
    let scrollback = {
        let sessions = sessions
            .lock()
            .map_err(|_| "PTY sessions lock poisoned".to_string())?;
        sessions
            .get(&id)
            .map(|session| Arc::clone(&session.scrollback))
    };
    let Some(scrollback) = scrollback else {
        return Ok(());
    };

    tokio::task::spawn_blocking(move || {
        let mut buffer = scrollback
            .lock()
            .map_err(|_| "PTY scrollback lock poisoned".to_string())?;
        reset_scrollback_buffer(&mut buffer);
        let path = scrollback_path(&app, &id)?;
        scrollback_writer()
            .send(ScrollbackWrite::Overwrite {
                path,
                bytes: Vec::new(),
            })
            .map_err(|_| "scrollback writer unavailable".to_string())?;
        drop(buffer);
        wait_for_scrollback_writer()
    })
    .await
    .map_err(|error| format!("clear_pty_scrollback task failed: {error}"))?
}

fn reset_scrollback_buffer(buffer: &mut ScrollbackBuffer) {
    buffer.data.clear();
    buffer.pending.clear();
    buffer.dirty = false;
    buffer.last_flush = Instant::now();
}

#[tauri::command]
pub async fn write_pty(
    sessions: State<'_, PtySessions>,
    id: String,
    data: String,
) -> Result<(), String> {
    // lock, qualquer attach/resize/kill/spawn em outro PTY ficaria parado.
    // Pega o handle do writer e SOLTA o lock global de sessions antes de
    // escrever. Escrita pode bloquear no PTY (buffer cheio); se segurassemos o
    // lock, qualquer attach/resize/kill/spawn em outro PTY ficaria parado.
    // `spawn_blocking` isola isso da thread de despacho do Tauri — sem isso,
    // uma escrita presa (agente que parou de drenar stdin) travava todo
    // comando IPC atrás dela, não só este terminal.
    let sessions: PtySessions = Arc::clone(sessions.inner());
    tokio::task::spawn_blocking(move || {
        let writer = {
            let sessions = sessions
                .lock()
                .map_err(|_| "PTY sessions lock poisoned".to_string())?;
            let session = sessions
                .get(&id)
                .ok_or_else(|| format!("PTY not found: {id}"))?;
            Arc::clone(&session.writer)
        };
        let mut writer = writer
            .lock()
            .map_err(|_| "PTY writer lock poisoned".to_string())?;
        writer
            .write_all(data.as_bytes())
            .map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("write_pty: falha na task bloqueante: {error}"))?
}

#[tauri::command]
pub async fn resize_pty(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    remote: State<'_, Arc<crate::remote::RemoteHub>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // Mesmo padrão de write_pty: clona os handles (master/writer) e SOLTA o
    // lock global de sessions antes de chamar master.resize — ConPTY é
    // conhecido por travar num resize ocasionalmente no Windows; sem soltar o
    // lock antes, isso prendia kill/write/attach de TODOS os outros terminais.
    let sessions: PtySessions = Arc::clone(sessions.inner());
    let remote_hub = Arc::clone(remote.inner());
    tokio::task::spawn_blocking(move || {
        if pty_debug_enabled() {
            let _ = append_spawn_log(&app, &format!("[pty-debug] {id}: resize_pty {cols}x{rows}"));
        }
        let (master, writer, is_opencode, nudge_lock) = {
            let sessions = sessions
                .lock()
                .map_err(|_| "PTY sessions lock poisoned".to_string())?;
            let session = sessions
                .get(&id)
                .ok_or_else(|| format!("PTY not found: {id}"))?;
            (
                Arc::clone(&session.master),
                Arc::clone(&session.writer),
                session.command.as_deref() == Some("opencode"),
                Arc::clone(&session.opencode_nudge_lock),
            )
        };

        {
            let master = master
                .lock()
                .map_err(|_| "PTY master lock poisoned".to_string())?;
            master
                .resize(PtySize {
                    rows: rows.max(1),
                    cols: cols.max(1),
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|error| error.to_string())?;
        }
        // Espelho do controle remoto: o dispositivo remoto é um viewer
        // independente do painel local, então publica sempre — o gate de
        // visibilidade abaixo vale só pro xterm desta janela.
        remote_hub.publish(&id, || {
            serde_json::json!({
                "type": "pty_resize",
                "ptyId": &id,
                "cols": cols.max(1),
                "rows": rows.max(1),
            })
        });

        //

        // entrega/tratamento desse sinal e o Ctrl+L chegando no stdin logo

        // no meio — a tela sai com blocos de glifo corrompidos em vez de

        //
        // `try_claim_opencode_nudge` coordena com o nudge de boot (primeiro
        // output do processo, em `spawn_pty`) — os dois podem disparar quase

        // OpenCode no Windows/Linux/macOS nem sempre redesenha a TUI após
        // resize — a tela fica truncada até a próxima tecla. Ctrl+L (Form
        // Feed) força o redraw em todas as plataformas.
        //
        // `master.resize()` acima só ajusta o winsize do PTY e dispara
        // SIGWINCH pro processo filho — não há garantia de ordem entre a
        // entrega/tratamento desse sinal e o Ctrl+L chegando no stdin logo
        // em seguida. O próprio framework de TUI do OpenCode já reage ao
        // SIGWINCH com seu próprio redraw assíncrono; mandar o Ctrl+L sem
        // nenhuma folga faz os dois redraws (um calculado pra geometria
        // antiga, outro pra nova) correrem em paralelo e se sobrescreverem
        // no meio — a tela sai com blocos de glifo corrompidos em vez de
        // conteúdo real, sobretudo durante um arraste contínuo de divisor
        // (vários resizes seguidos). Uma folga curta aqui não é uma garantia
        // de sincronização de verdade (não há como saber quando o redraw do
        // processo filho termina de fato), mas reduz bastante a janela da
        // corrida — já estamos numa `spawn_blocking`, então dormir aqui não
        // trava nenhum outro comando.
        //
        // `try_claim_opencode_nudge` coordena com o nudge de boot (primeiro
        // output do processo, em `spawn_pty`) — os dois podem disparar quase
        // juntos num terminal recém-criado que já é redimensionado logo
        // depois do spawn; sem essa trava, os DOIS nudges mandavam Ctrl+L
        // e o OpenCode fazia dois redesenhos concorrentes que se
        // sobrepunham na tela (confirmado analisando os bytes crus do
        // scrollback — texto de um redraw colidindo com blocos do outro).
        if is_opencode {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let claimed = try_claim_opencode_nudge(&nudge_lock);
            if pty_debug_enabled() {
                let _ = append_spawn_log(
                    &app,
                    &format!(
                        "[pty-debug] {id}: nudge de resize {} (50ms após master.resize)",
                        if claimed {
                            "ENVIADO"
                        } else {
                            "pulado (perdeu a trava)"
                        }
                    ),
                );
            }
            if claimed {
                if let Ok(mut writer) = writer.lock() {
                    let _ = writer.write_all(&[12]);
                    let _ = writer.flush();
                }
            }
        }

        Ok(())
    })
    .await
    .map_err(|error| format!("resize_pty: falha na task bloqueante: {error}"))?
}

/// Asks for the session's process tree to end; returns how many processes that covered, or why it
/// could not (with no root PID registered, only the `taskkill /T` fallback runs).
fn terminate_session(session: PtySession) -> Result<usize, String> {
    let tree = process_tree::kill_pty_tree(&session.pty_id).map(|pids| pids.len());
    process_tree::unregister_pty(&session.pty_id);
    {
        let (lock, cvar) = &*session.read_active;
        if let Ok(mut active) = lock.lock() {
            *active = true;
            cvar.notify_all();
        }
    }
    kill_tree_without_holding_child(&session.child);
    tree
}

#[tauri::command]
pub async fn kill_pty(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
) -> Result<(), String> {
    // fim do `if let`), prendendo TODO outro comando PTY (spawn/attach/write/
    // `terminate_session` roda taskkill/wait pela árvore inteira — pode
    // demorar (ou travar) de verdade. Antes, o MutexGuard de `sessions` ficava
    // vivo durante essa chamada inteira (guard só cai no fim da função, não no
    // fim do `if let`), prendendo TODO outro comando PTY (spawn/attach/write/
    // resize/kill de qualquer outro terminal) atrás dele — e como o mutex não
    // é reentrante, nem uma segunda tentativa de matar o MESMO terminal
    // travado conseguia rodar. Agora: solta o lock assim que remove a sessão
    // do mapa, e só then faz o trabalho bloqueante, dentro de spawn_blocking
    // pra também não travar a thread de despacho do Tauri.
    let sessions: PtySessions = Arc::clone(sessions.inner());
    tokio::task::spawn_blocking(move || {
        let session = {
            let mut sessions = sessions
                .lock()
                .map_err(|_| "PTY sessions lock poisoned".to_string())?;
            sessions.remove(&id)
        };

        if let Some(session) = session {
            session.teardown.store(TEARDOWN_KILLED, Ordering::SeqCst);
            let _ = terminate_session(session);
        }

        delete_scrollback(&app, &id)
    })
    .await
    .map_err(|error| format!("kill_pty: falha na task bloqueante: {error}"))?
}

/// Removes several PTYs from shared state in one IPC call and tears their process trees down in
/// parallel. Group standby must not fire dozens of independent best-effort requests and then erase
/// the only IDs that could retry them.
#[tauri::command]
pub async fn kill_ptys(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    ids: Vec<String>,
) -> Result<Vec<String>, String> {
    let sessions: PtySessions = Arc::clone(sessions.inner());
    tokio::task::spawn_blocking(move || {
        let unique_ids = ids.into_iter().collect::<std::collections::HashSet<_>>();
        let drained = {
            let mut sessions = sessions
                .lock()
                .map_err(|_| "PTY sessions lock poisoned".to_string())?;
            unique_ids
                .iter()
                .filter_map(|id| sessions.remove(id).map(|session| (id.clone(), session)))
                .collect::<Vec<_>>()
        };

        let (done, finished) = std::sync::mpsc::channel::<String>();
        for (id, session) in drained {
            session.teardown.store(TEARDOWN_KILLED, Ordering::SeqCst);
            let done = done.clone();
            let _ = std::thread::Builder::new()
                .name("alethe-pty-batch-kill".to_string())
                .spawn(move || {
                    let _ = terminate_session(session);
                    let _ = done.send(id);
                });
        }
        drop(done);

        let deadline = Instant::now() + Duration::from_secs(8);
        let mut completed = Vec::new();
        while completed.len() < unique_ids.len() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match finished.recv_timeout(remaining) {
                Ok(id) => completed.push(id),
                Err(_) => break,
            }
        }
        for id in &unique_ids {
            let _ = delete_scrollback(&app, id);
        }
        Ok(completed)
    })
    .await
    .map_err(|error| format!("kill_ptys: batch task failed: {error}"))?
}

///

/// Estaciona um runtime sem apagar scrollback nem identidade de sessão.
///
/// Encerra o processo e espera o reader persistir sua última cauda. Assim um
/// novo spawn com o mesmo id nunca disputa com writes do reader antigo.
pub fn suspend_session(app: &AppHandle, sessions: &PtySessions, id: &str) -> Result<bool, String> {
    suspend_session_with_reason(app, sessions, id, "user-request")
}

pub fn suspend_session_with_reason(
    app: &AppHandle,
    sessions: &PtySessions,
    id: &str,
    reason: &'static str,
) -> Result<bool, String> {
    let session = {
        let mut sessions = sessions
            .lock()
            .map_err(|_| "PTY sessions lock poisoned".to_string())?;
        sessions.remove(id)
    };
    let Some(session) = session else {
        return Ok(false);
    };

    session.teardown.store(TEARDOWN_SUSPENDED, Ordering::SeqCst);
    // Precisa rodar antes de `unregister_pty` (abaixo) — `kill_pty_tree` busca
    // o PID raiz no mesmo registro que `unregister_pty` limpa.
    let _ = process_tree::kill_pty_tree(&session.pty_id);
    kill_tree_without_holding_child(&session.child);
    {
        let (lock, cvar) = &*session.read_active;
        if let Ok(mut active) = lock.lock() {
            *active = true;
            cvar.notify_all();
        }
    }
    // Close the pseudoconsole BEFORE waiting on the barrier. On Windows ConPTY,
    // killing the child does not close the output pipe — the blocking reader
    // stays in read() until the master (HPCON) is dropped. Holding the session
    // across the wait would deadlock the reader against its own flush barrier.
    let reader_done = Arc::clone(&session.reader_done);
    drop(session);

    let (done_lock, done_ready) = &*reader_done;
    let done = done_lock
        .lock()
        .map_err(|_| "PTY reader barrier lock poisoned".to_string())?;
    let (done, timeout) = done_ready
        .wait_timeout_while(done, Duration::from_secs(5), |status| status.is_none())
        .map_err(|_| "PTY reader barrier lock poisoned".to_string())?;
    if timeout.timed_out() && done.is_none() {
        return Err("PTY reader flush barrier timed out".to_string());
    }
    if *done != Some(true) {
        return Err("PTY reader failed to persist scrollback".to_string());
    }
    let _ = app.emit(
        "resource://pty-suspended",
        PtySuspendedPayload {
            id: id.to_string(),
            reason,
        },
    );
    let _ = append_spawn_log(app, &format!("suspend id={id} reason={reason}"));
    if let Ok(mut sessions) = sessions.lock() {
        sessions.remove(id);
    }
    Ok(true)
}

#[tauri::command]
pub async fn suspend_pty(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
) -> Result<bool, String> {
    // `suspend_session` já solta o lock de `sessions` antes do kill (remove
    // sob lock, guard cai no fim do bloco `{}`), mas ainda espera até 5s pelo
    // flush do reader — bloqueante o bastante pra travar a thread de despacho
    // do Tauri sem spawn_blocking.
    let sessions: PtySessions = Arc::clone(sessions.inner());
    tokio::task::spawn_blocking(move || suspend_session(&app, &sessions, &id))
        .await
        .map_err(|error| format!("suspend_pty: falha na task bloqueante: {error}"))?
}

#[tauri::command]
pub async fn get_pty_cwd(
    sessions: State<'_, PtySessions>,
    id: String,
) -> Result<Option<String>, String> {
    let sessions: PtySessions = Arc::clone(sessions.inner());
    let result = tokio::task::spawn_blocking(move || {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let sessions = sessions.lock().ok()?;
        let session = sessions.get(&id)?;
        let pid_u32 = session.child.lock().ok()?.process_id()?;
        drop(sessions);

        let mut sys = System::new();
        let pid = Pid::from_u32(pid_u32);
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            ProcessRefreshKind::new().with_cwd(sysinfo::UpdateKind::Always),
        );
        let cwd = sys.process(pid)?.cwd()?.to_string_lossy().to_string();
        Some(cwd)
    })
    .await
    .unwrap_or(None);
    Ok(result)
}

#[tauri::command]
pub fn set_pty_read_state(
    sessions: State<'_, PtySessions>,
    id: String,
    active: bool,
) -> Result<(), String> {
    let sessions = sessions
        .lock()
        .map_err(|_| "PTY sessions lock poisoned".to_string())?;
    if let Some(session) = sessions.get(&id) {
        let (lock, cvar) = &*session.read_active;
        if let Ok(mut read_active) = lock.lock() {
            *read_active = active;
            if active {
                cvar.notify_all();
            }
        }
    }
    Ok(())
}

/// Não pausa a leitura do PTY (`read_active` faz isso e travaria o agente) —
/// só decide se o coalescer manda o próximo lote pro canal `data` (render) ou
/// `activity` (throttlado). Barato: um `AtomicBool::store`, sem tocar no
/// hot path do reader/coalescer além do `load` já feito ali.
#[tauri::command]
/// Returns whether the flag was applied. `false` means the session was not there to receive it —
/// the caller must not assume the stream is now on, because output gating stays as it was.
pub fn set_pty_visible(
    sessions: State<'_, PtySessions>,
    id: String,
    visible: bool,
) -> Result<bool, String> {
    let sessions = sessions
        .lock()
        .map_err(|_| "PTY sessions lock poisoned".to_string())?;
    match sessions.get(&id) {
        Some(session) => {
            session.visible.store(visible, Ordering::Relaxed);
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command]
pub async fn set_pty_priority(
    _sessions: State<'_, PtySessions>,
    _id: String,
    _active: bool,
) -> Result<(), String> {
    let _sessions: PtySessions = Arc::clone(_sessions.inner());
    tokio::task::spawn_blocking(move || {
        #[cfg(windows)]
        unsafe {
            let sessions = _sessions
                .lock()
                .map_err(|_| "PTY sessions lock poisoned".to_string())?;
            if let Some(session) = sessions.get(&_id) {
                if let Ok(child) = session.child.lock() {
                    if let Some(pid) = child.process_id() {
                        use windows_sys::Win32::Foundation::CloseHandle;
                        use windows_sys::Win32::System::Threading::{
                            OpenProcess, SetPriorityClass, IDLE_PRIORITY_CLASS,
                            NORMAL_PRIORITY_CLASS, PROCESS_SET_INFORMATION,
                        };

                        let handle = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
                        if !handle.is_null() {
                            let priority = if _active {
                                NORMAL_PRIORITY_CLASS
                            } else {
                                IDLE_PRIORITY_CLASS
                            };
                            let _ = SetPriorityClass(handle, priority);
                            let _ = CloseHandle(handle);
                        }
                    }
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("set_pty_priority: falha na task bloqueante: {error}"))?
}

#[tauri::command]
pub async fn list_pty_processes(
    sessions: State<'_, PtySessions>,
) -> Result<Vec<PtyProcessSnapshot>, String> {
    // lento sob carga. Igual aos outros comandos PTY, isolado em
    // `sysinfo::refresh_processes_specifics` varre processos do SO — pode ser
    // lento sob carga. Igual aos outros comandos PTY, isolado em
    // spawn_blocking pra não travar a thread de despacho do Tauri. Mantém o
    // contrato antigo (nunca falha de verdade pro frontend) devolvendo lista
    // vazia se a task bloqueante falhar por algum motivo.
    let sessions: PtySessions = Arc::clone(sessions.inner());
    let result: Vec<PtyProcessSnapshot> = tokio::task::spawn_blocking(move || {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

        let raw = {
            let Ok(sessions) = sessions.lock() else {
                return Vec::new();
            };
            sessions
                .iter()
                .map(|(id, session)| {
                    // try_lock, not lock: this snapshot is telemetry and it runs while holding
                    // the global session lock, which every keystroke needs. Waiting here for a
                    // busy child would stop the whole app from accepting input to report a pid.
                    let pid = session
                        .child
                        .try_lock()
                        .ok()
                        .and_then(|mut child| child.process_id());
                    (
                        id.clone(),
                        pid,
                        session.command.clone(),
                        session.cwd.clone(),
                    )
                })
                .collect::<Vec<_>>()
        };

        let pids = raw
            .iter()
            .filter_map(|(_, pid, _, _)| pid.map(Pid::from_u32))
            .collect::<Vec<_>>();
        let mut sys = System::new();
        if !pids.is_empty() {
            sys.refresh_processes_specifics(
                ProcessesToUpdate::Some(&pids),
                ProcessRefreshKind::everything(),
            );
        }

        raw.into_iter()
            .map(|(id, pid, command, cwd)| {
                let process = pid.and_then(|pid| sys.process(Pid::from_u32(pid)));
                let memory_mb = process
                    .map(|process| process.memory() as f64 / 1024.0 / 1024.0)
                    .unwrap_or(0.0);
                let process_name =
                    process.map(|process| process.name().to_string_lossy().to_string());
                let cmdline = process.map(|process| {
                    process
                        .cmd()
                        .iter()
                        .map(|part| part.to_string_lossy())
                        .collect::<Vec<_>>()
                        .join(" ")
                });
                PtyProcessSnapshot {
                    id,
                    pid,
                    command,
                    cwd,
                    process_name,
                    cmdline,
                    memory_mb,
                    alive: process.is_some(),
                }
            })
            .collect()
    })
    .await
    .unwrap_or_default();
    Ok(result)
}

pub fn load_scrollback(app: &AppHandle, id: &str) -> Result<VecDeque<u8>, String> {
    let path = scrollback_path(app, id)?;
    if !path.exists() {
        return Ok(VecDeque::new());
    }

    let mut data = fs::read(path).map_err(|error| error.to_string())?;
    if data.len() > SCROLLBACK_CAP_BYTES {
        data = data[data.len() - SCROLLBACK_CAP_BYTES..].to_vec();
    }
    Ok(data.into())
}

/// Writer global de scrollback: uma única thread em background recebe
/// `(path, bytes)` e escreve. Evita spawnar uma thread a cada flush (250ms por
/// PTY ativo). Vive pela vida do processo — sem teardown por PTY, sem vazar thread.
enum ScrollbackWrite {
    /// Anexa `bytes` ao fim do `.bin` (cria se não existir). Compacta pra cauda
    /// de `SCROLLBACK_CAP_BYTES` se o arquivo passar de `SCROLLBACK_COMPACT_BYTES`.
    Append { path: PathBuf, bytes: Vec<u8> },
    /// Reescreve o arquivo inteiro (usado no teardown do PTY, uma vez).
    Overwrite { path: PathBuf, bytes: Vec<u8> },
    /// Confirma que todos os appends/overwrites anteriores já chegaram ao disco.
    Barrier(std::sync::mpsc::Sender<()>),
}

/// Anexa e, se o arquivo cresceu além do limite, compacta pra cauda do cap.
/// Compactar é raro (a cada ~4 MB de saída), então o custo é amortizado.
fn append_and_maybe_compact(path: &Path, bytes: &[u8]) {
    let mut file = match fs::OpenOptions::new().create(true).append(true).open(path) {
        Ok(file) => file,
        Err(_) => return,
    };
    if file.write_all(bytes).is_err() {
        return;
    }
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    drop(file);
    if len > SCROLLBACK_COMPACT_BYTES {
        if let Ok(all) = fs::read(path) {
            if all.len() > SCROLLBACK_CAP_BYTES {
                let tail = &all[all.len() - SCROLLBACK_CAP_BYTES..];
                let _ = fs::write(path, tail);
            }
        }
    }
}

/// Writer global de scrollback: uma única thread em background recebe comandos
/// e escreve. Evita spawnar uma thread a cada flush (250ms por PTY ativo).
/// Vive pela vida do processo — sem teardown por PTY, sem vazar thread.
fn scrollback_writer() -> &'static std::sync::mpsc::Sender<ScrollbackWrite> {
    static WRITER: std::sync::OnceLock<std::sync::mpsc::Sender<ScrollbackWrite>> =
        std::sync::OnceLock::new();
    WRITER.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<ScrollbackWrite>();
        thread::spawn(move || {
            while let Ok(msg) = rx.recv() {
                match &msg {
                    ScrollbackWrite::Append { path, bytes } => {
                        if let Some(parent) = path.parent() {
                            let _ = fs::create_dir_all(parent);
                        }
                        append_and_maybe_compact(path, bytes);
                    }
                    ScrollbackWrite::Overwrite { path, bytes } => {
                        if let Some(parent) = path.parent() {
                            let _ = fs::create_dir_all(parent);
                        }
                        let _ = fs::write(path, bytes);
                    }
                    ScrollbackWrite::Barrier(done) => {
                        let _ = done.send(());
                    }
                }
            }
        });
        tx
    })
}

pub(crate) fn wait_for_scrollback_writer() -> Result<(), String> {
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    scrollback_writer()
        .send(ScrollbackWrite::Barrier(done_tx))
        .map_err(|_| "scrollback writer unavailable".to_string())?;
    done_rx
        .recv_timeout(std::time::Duration::from_secs(3))
        .map_err(|_| "scrollback writer barrier timed out".to_string())
}

pub fn push_scrollback(
    app: &AppHandle,
    id: &str,
    scrollback: &Arc<Mutex<ScrollbackBuffer>>,
    data: &[u8],
) -> Result<(), String> {
    let mut buffer = scrollback
        .lock()
        .map_err(|_| "PTY scrollback lock poisoned".to_string())?;
    buffer.data.extend(data);
    // Drena de uma vez em vez de pop_front em loop (uma operação vs N).
    if buffer.data.len() > SCROLLBACK_CAP_BYTES {
        let excess = buffer.data.len() - SCROLLBACK_CAP_BYTES;
        buffer.data.drain(..excess);
    }
    // Acumula SÓ os bytes novos pro append. O anel em memória (`data`) continua
    // servindo o getScrollback; o disco recebe só o delta, não os 4 MB inteiros.
    buffer.pending.extend_from_slice(data);
    buffer.dirty = true;

    if buffer.last_flush.elapsed().as_millis() < SCROLLBACK_FLUSH_INTERVAL_MS {
        return Ok(());
    }

    if buffer.data.capacity() > SCROLLBACK_CAP_BYTES * 2 {
        buffer.data.shrink_to(SCROLLBACK_CAP_BYTES);
    }
    let bytes = std::mem::take(&mut buffer.pending);
    buffer.last_flush = Instant::now();
    buffer.dirty = false;
    drop(buffer);

    if bytes.is_empty() {
        return Ok(());
    }

    // Disk write em thread separada — segurar o reader thread aqui causava
    // latência visível de digitação (10-50ms por flush no Windows) propagando
    // pra TODOS os terminais com qualquer atividade.
    let path = scrollback_path(app, id)?;
    // Envia pro writer global em vez de spawnar uma thread por flush.
    let _ = scrollback_writer().send(ScrollbackWrite::Append { path, bytes });
    Ok(())
}

pub fn flush_scrollback(
    app: &AppHandle,
    id: &str,
    scrollback: &Arc<Mutex<ScrollbackBuffer>>,
) -> Result<(), String> {
    let mut buffer = scrollback
        .lock()
        .map_err(|_| "PTY scrollback lock poisoned".to_string())?;
    if !buffer.dirty {
        return Ok(());
    }
    // No teardown reescrevemos o anel inteiro (capado a 4 MB) — é a compactação
    // final do arquivo. `data` já inclui o que estava em `pending`.
    let bytes = buffer.data.iter().copied().collect::<Vec<_>>();
    buffer.pending.clear();
    buffer.last_flush = Instant::now();
    buffer.dirty = false;
    drop(buffer);

    // Via o writer global pra manter ordem FIFO com Appends ainda na fila —
    // senão um Append pendente poderia sobrescrever este Overwrite e duplicar
    // a cauda no disco.
    let path = scrollback_path(app, id)?;
    let _ = scrollback_writer().send(ScrollbackWrite::Overwrite { path, bytes });
    Ok(())
}

pub fn delete_scrollback(app: &AppHandle, id: &str) -> Result<(), String> {
    let path = scrollback_path(app, id)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    let _ = scrollback_dir(app);
    Ok(())
}

/// Remove `.bin` órfãos — scrollback de terminais que não existem mais no
/// projects.json. Roda no startup, ANTES de qualquer spawn (sem corrida).
/// Conservador: só apaga se o id NÃO aparecer em nenhum lugar do texto do
/// projects.json (ids são nanoids; colisão com texto não-relacionado é
/// improvável). Se o projects.json não puder ser lido, não apaga nada.
pub fn cleanup_orphan_scrollback(app: &AppHandle) {
    let Ok(dir) = scrollback_dir(app) else {
        return;
    };
    if !dir.is_dir() {
        return;
    }
    let projects_text = match crate::paths::projects_file_path(app) {
        Ok(path) => fs::read_to_string(&path).unwrap_or_default(),
        Err(_) => return,
    };
    // Vazio = sem projects.json legível → melhor não arriscar apagar nada.
    if projects_text.is_empty() {
        return;
    }
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("bin") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !projects_text.contains(stem) {
            let _ = fs::remove_file(&path);
        }
    }
}

/// How long shutdown waits for terminal processes to die before giving up on them.
const SHUTDOWN_KILL_TIMEOUT: Duration = Duration::from_secs(4);

/// What a shutdown teardown got through: how many sessions it tore down, and its app-events lines
/// (see `teardown_log`).
pub struct ShutdownTeardown {
    pub sessions: usize,
    pub summary: String,
    pub lines: Vec<String>,
}

/// Removes every session from shared state immediately and terminates their process trees in
/// parallel, waiting at most `SHUTDOWN_KILL_TIMEOUT`. The caller's thread blocks for that wait, so
/// the app hides its windows first (#275).
pub fn kill_all_sessions_background(sessions: &PtySessions) -> ShutdownTeardown {
    let drained = sessions
        .lock()
        .ok()
        .map(|mut sessions| {
            sessions
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    // One thread per session, then wait for them. Two reasons this is not fire-and-forget:
    // terminating a session runs `taskkill` and waits for it, so doing them in sequence costs the
    // sum of every kill; and a detached thread dies with the process, which on shutdown is
    // immediate — the agents were simply left running, and the next attempt to resume one of their
    // sessions found the old process still holding it.
    let ids: Vec<String> = drained
        .iter()
        .map(|session| session.pty_id.clone())
        .collect();
    let (done, finished) = std::sync::mpsc::channel::<SessionKill>();
    for session in drained {
        let done = done.clone();
        let _ = std::thread::Builder::new()
            .name("alethe-pty-shutdown".to_string())
            .spawn(move || {
                let started = Instant::now();
                let id = session.pty_id.clone();
                let outcome = terminate_session(session);
                let _ = done.send((id, started.elapsed().as_millis(), outcome));
            });
    }
    drop(done);

    // Bounded: a kill that will not finish must not hold the window open forever.
    let deadline = Instant::now() + SHUTDOWN_KILL_TIMEOUT;
    let mut requested = Vec::with_capacity(ids.len());
    while requested.len() < ids.len() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let Ok(kill) = finished.recv_timeout(remaining) else {
            break;
        };
        requested.push(kill);
    }
    let (summary, lines) = teardown_log(&ids, &requested);
    ShutdownTeardown {
        sessions: ids.len(),
        summary,
        lines,
    }
}

/// A session's PTY id, how long `terminate_session` took, and what it returned.
type SessionKill = (String, u128, Result<usize, String>);

/// The shutdown's app-events lines, each well under the log's 512 characters: a summary, then one
/// line per session. `requested_ms` is how long asking its tree to end took (TerminateProcess
/// returns before the process is gone), with how many processes that covered or why it failed;
/// `pending` is a session whose teardown had not returned when the wait ran out.
fn teardown_log(ids: &[String], requested: &[SessionKill]) -> (String, Vec<String>) {
    let mut lines: Vec<String> = requested
        .iter()
        .map(|(id, ms, outcome)| match outcome {
            Ok(pids) => format!("id={id} requested_ms={ms} pids={pids}"),
            Err(error) => format!(
                "id={id} requested_ms={ms} error={}",
                error.chars().take(200).collect::<String>()
            ),
        })
        .collect();
    let pending = ids
        .iter()
        .filter(|id| !requested.iter().any(|(done, _, _)| done == *id));
    lines.extend(pending.map(|id| format!("id={id} pending")));
    let summary = format!(
        "requested={}/{} pending={}",
        requested.len(),
        ids.len(),
        lines.len() - requested.len()
    );
    (summary, lines)
}

/// Resultado da instalação do Job Object — lido por `crash_watch.rs` (grava
/// no heartbeat, pra ficar registrado se um crash acontecer depois) e por um
/// comando Tauri de diagnóstico. Sem isso, uma falha de `install_kill_on_close_guard`
/// era 100% silenciosa: ninguém saberia que a rede de segurança contra
/// terminais órfãos estava inativa naquela sessão até órfãos aparecerem.
static JOB_GUARD_ACTIVE: OnceLock<bool> = OnceLock::new();

/// Status da rede de segurança (Job Object) desta sessão. `false` antes de
/// `install_kill_on_close_guard` rodar (só acontece bem cedo no boot) ou em
/// qualquer plataforma não-Windows.
pub fn job_guard_active() -> bool {
    JOB_GUARD_ACTIVE.get().copied().unwrap_or(false)
}

/// e seus descendentes (node/claude/codex/MCP) herdam o job. Enquanto o app vive,

/// Rede de segurança no Windows contra terminais órfãos. Cria um Job Object com
/// KILL_ON_JOB_CLOSE e assigna o PRÓPRIO processo do app; todos os shells ConPTY
/// e seus descendentes (node/claude/codex/MCP) herdam o job. Enquanto o app vive,
/// o handle do job fica aberto; quando o app morre por QUALQUER via — fechar
/// normal, crash ou kill forçado (onde `RunEvent::Exit` NÃO roda) — o SO fecha o
/// handle e mata a árvore inteira. Complementa (não substitui) `kill_all_sessions`.
/// Deve ser chamado bem cedo no boot, antes de qualquer spawn. Se o SO recusar
/// em qualquer etapa, não há regressão (comportamento igual a antes desta rede
/// existir) — mas agora fica registrado em `JOB_GUARD_ACTIVE`/stderr em vez de
/// falhar 100% em silêncio.
#[cfg(windows)]
pub fn install_kill_on_close_guard() {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    let active = unsafe {
        // `lpJobAttributes = null` já cria o handle como NÃO herdável por
        // padrão (SECURITY_ATTRIBUTES.bInheritHandle implícito = FALSE) — não
        // precisa de SetHandleInformation extra pra isso.
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            eprintln!("[pty] install_kill_on_close_guard: CreateJobObjectW falhou (GetLastError não capturado)");
            false
        } else {
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                eprintln!("[pty] install_kill_on_close_guard: SetInformationJobObject falhou");
                let _ = CloseHandle(job);
                false
            } else if AssignProcessToJobObject(job, GetCurrentProcess()) != 0 {
                // feche o Job Object cedo demais e elimine os terminais
                // Mantém o handle num OnceLock estático. Além de documentar a
                // posse do recurso, isso impede que uma refatoração futura
                // feche o Job Object cedo demais e elimine os terminais
                // enquanto o app ainda está vivo.
                let _ = PTY_JOB_HANDLE.set(job as isize);
                true
            } else {
                // Se o Windows recusar a associação (por exemplo, uma
                // política de jobs aninhados), não deixe um handle inválido
                // vazando.
                eprintln!(
                    "[pty] install_kill_on_close_guard: AssignProcessToJobObject falhou — \
                     rede de segurança contra terminais órfãos INATIVA nesta sessão"
                );
                let _ = CloseHandle(job);
                false
            }
        }
    };
    let _ = JOB_GUARD_ACTIVE.set(active);
}

#[cfg(not(windows))]
pub fn install_kill_on_close_guard() {
    // On Linux there is no equivalent of a Windows Job Object. Instead, the shutdown
    // handler in lib.rs calls kill_all_sessions_background() on ExitRequested, which
    // now works thanks to the SIGTERM/SIGKILL process-group kill in kill_process_tree.
    // On the next startup, sweep_orphans_from_previous_session() kills any grandchild
    // processes that escaped the previous shutdown.
    let _ = JOB_GUARD_ACTIVE.set(true);
}

/// What `spawn_pty` holds from its first step until its session is registered: the folder it
/// launches in, held as starting there, and the reservation of its id.
struct BegunSpawn {
    folder: Option<PathBuf>,
    memory_wait_ms: u128,
    _starting: crate::worktrees::PendingSpawn,
    _reservation: SpawnReservation,
}

/// `spawn_pty`'s first step, in order: its folder is resolved, checked and held as starting before
/// anything waits, so no worktree removal can take it meanwhile; then the id is reserved and the
/// memory wait runs. `None` when a session with this id already runs.
fn begin_pty_spawn(
    sessions: &PtySessions,
    id: &str,
    cwd: Option<&str>,
    wait_for_memory: impl FnOnce() -> u128,
) -> Result<Option<BegunSpawn>, String> {
    let folder = spawn_cwd(cwd)?;
    let starting = crate::worktrees::begin_spawn(folder.as_deref())?;
    let Some(reservation) = reserve_spawn(sessions, id)? else {
        return Ok(None);
    };
    let memory_wait_ms = wait_for_memory();
    Ok(Some(BegunSpawn {
        folder,
        memory_wait_ms,
        _starting: starting,
        _reservation: reservation,
    }))
}

/// The folder a terminal starts in, absolute. None asked: the shell's own. One asked that does not
/// exist, or can't be read, fails the spawn rather than starting it somewhere the user did not
/// choose.
fn spawn_cwd(cwd: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(folder) = cwd.and_then(crate::worktrees::absolute_cwd) else {
        return Ok(None);
    };
    match std::fs::metadata(&folder) {
        Ok(found) if found.is_dir() => Ok(Some(folder)),
        Ok(_) => Err(format!(
            "cwd_not_found: {} is not a folder",
            folder.display()
        )),
        Err(error) => Err(cwd_error(&folder, &error)),
    }
}

/// Missing is told apart from there but unreadable (permissions, a lock, a dead share).
fn cwd_error(folder: &Path, error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        format!("cwd_not_found: {} does not exist", folder.display())
    } else {
        format!("cwd_unreadable: {}: {error}", folder.display())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("alethe-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_shell_from_the_frontend_runs_only_as_an_absolute_file() {
        // Tests run from the crate root, where `Cargo.toml` is a file under a relative path.
        assert!(Path::new("Cargo.toml").is_file());
        let shell = |path| resolve_launcher(Some(path), None, None).0;
        assert_eq!(shell("Cargo.toml"), None);
        assert_eq!(shell("cmd /c whoami"), None);
        assert_eq!(shell("   "), None);
        let absolute = std::env::current_dir().unwrap().join("Cargo.toml");
        let absolute = absolute.to_string_lossy();
        assert_eq!(shell(&absolute).as_deref(), Some(&*absolute));
    }

    #[test]
    fn a_plain_shell_falls_back_to_the_default_then_auto_detect_and_says_so() {
        let path = |name: &str| {
            let path = std::env::current_dir().unwrap().join(name);
            path.to_string_lossy().into_owned()
        };
        let (installed, gone) = (path("Cargo.toml"), path("missing-shell.exe"));
        let plain = |own: &str, default: &str| resolve_launcher(Some(own), Some(default), None);
        assert_eq!(plain(&installed, &gone), (Some(installed.clone()), false));
        assert_eq!(plain(&gone, &installed), (Some(installed.clone()), true));
        // Neither runs: no launcher, so the builder takes the platform's own shell.
        assert_eq!(plain(&gone, &gone), (None, true));
        // An agent's missing CLI path is no shell of a tab's own: no notice about one.
        assert!(!resolve_launcher(Some(&gone), None, Some("alethe-missing-cli")).1);
    }

    #[test]
    fn spawn_pty_holds_its_folder_from_its_first_step_through_the_memory_wait() {
        let sessions: PtySessions = Arc::new(Mutex::new(HashMap::new()));
        let dir = scratch_dir("begin");
        let root = dir.canonicalize().unwrap();

        let begun = begin_pty_spawn(&sessions, "pty-begin", Some(&dir.to_string_lossy()), || {
            // However long this wait, the folder can't be marked for removal meanwhile.
            assert_eq!(
                crate::worktrees::mark_removal(&root).err().as_deref(),
                Some("worktree_in_use_terminal")
            );
            7
        })
        .unwrap()
        .expect("a fresh id is reserved");
        assert_eq!(begun.folder.as_deref(), Some(dir.as_path()));
        assert_eq!(begun.memory_wait_ms, 7);

        drop(begun);
        assert!(crate::worktrees::mark_removal(&root).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn spawn_pty_refuses_a_missing_folder_before_waiting_for_memory() {
        let sessions: PtySessions = Arc::new(Mutex::new(HashMap::new()));
        let dir = scratch_dir("gone");
        std::fs::remove_dir_all(&dir).unwrap();
        let mut waited = false;

        let refused = begin_pty_spawn(&sessions, "pty-gone", Some(&dir.to_string_lossy()), || {
            waited = true;
            0
        });

        assert!(refused
            .err()
            .unwrap_or_default()
            .starts_with("cwd_not_found"));
        assert!(!waited);
    }

    #[test]
    fn a_folder_that_cannot_be_read_is_not_reported_missing() {
        let folder = Path::new(r"C:\locked");
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let missing = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert!(cwd_error(folder, &denied).starts_with("cwd_unreadable"));
        assert!(cwd_error(folder, &missing).starts_with("cwd_not_found"));
    }

    #[test]
    fn home_and_quoted_folders_open_as_they_used_to() {
        let home = dirs_next::home_dir().unwrap();
        let dir = scratch_dir("quoted");
        assert_eq!(spawn_cwd(Some("~")).unwrap(), Some(home));
        assert_eq!(
            spawn_cwd(Some(&format!("\"{}\"", dir.display()))).unwrap(),
            Some(dir.clone())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_requested_cwd_that_vanished_fails_the_spawn_instead_of_moving_it() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("alethe-cwd-{nanos}"));
        assert_eq!(spawn_cwd(None).unwrap(), None);
        assert_eq!(spawn_cwd(Some("  ")).unwrap(), None);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(
            spawn_cwd(Some(&dir.to_string_lossy())).unwrap(),
            Some(dir.clone())
        );

        std::fs::remove_dir_all(&dir).unwrap();
        let error = spawn_cwd(Some(&dir.to_string_lossy())).unwrap_err();
        assert!(error.starts_with("cwd_not_found"), "{error}");
    }

    #[cfg(not(windows))]
    #[test]
    fn process_group_target_never_widens_to_every_process() {
        assert_eq!(process_group_target(1234), Some(-1234));
        assert_eq!(process_group_target(0), None);
        assert_eq!(process_group_target(1), None);
        assert_eq!(process_group_target(u32::MAX), None);
    }

    #[cfg(not(windows))]
    #[test]
    fn kill_process_tree_ends_the_whole_group() {
        use std::os::unix::process::{CommandExt, ExitStatusExt};
        // Its own group, like the setsid() portable-pty does for a real shell.
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        kill_process_tree(child.id());
        assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGTERM));
    }

    /// Guards the invariant that made every terminal stop accepting keystrokes at once:
    /// `kill_process_tree` runs `taskkill` and waits for it, and holding the child lock across
    /// that stalled the snapshot path, which holds the global session lock that every write needs.
    /// Guards the reason agents outlived the app: shutdown spawned a detached thread that killed
    /// sessions one after another, and the process exited before it got through them. The next
    /// attempt to resume one of those sessions then found the old process still holding it.
    #[test]
    fn shutdown_waits_for_the_kills_it_started() {
        let source = include_str!("pty.rs");
        let body = source
            .split("pub fn kill_all_sessions_background")
            .nth(1)
            .expect("the shutdown path exists");
        let body = &body[..body.len().min(2200)];

        assert!(
            body.contains("recv_timeout"),
            "shutdown must wait for the kills: a detached thread dies with the process"
        );
        assert!(
            !body.contains(
                "for session in drained {
                terminate_session"
            ),
            "kills must not run one after another: each waits on taskkill, so the cost adds up"
        );
    }

    /// app-events.log keeps 512 characters of a line: 20 sessions with 21-character ids in one line
    /// lost the pending ones. Each session gets its own short line.
    #[test]
    fn shutdown_logs_one_short_line_per_session_and_names_the_pending_ones() {
        let ids: Vec<String> = (0..21).map(|n| format!("{n:0>21}")).collect();
        let requested: Vec<SessionKill> = ids[..20]
            .iter()
            .map(|id| (id.clone(), 4011, Ok(17)))
            .collect();
        let (summary, lines) = teardown_log(&ids, &requested);
        assert_eq!(summary, "requested=20/21 pending=1");
        assert_eq!(lines.len(), 21);
        assert_eq!(lines[0], format!("id={} requested_ms=4011 pids=17", ids[0]));
        assert_eq!(lines[20], format!("id={} pending", ids[20]));

        // An error is logged, cut short enough to keep its line well under the limit.
        let failed = [(ids[0].clone(), 3, Err("4: terminate error 5".repeat(100)))];
        let (summary, lines) = teardown_log(&ids[..1], &failed);
        assert_eq!(summary, "requested=1/1 pending=0");
        assert!(lines[0].starts_with(&format!("id={} requested_ms=3 error=4: terminate", ids[0])));
        assert!(lines.iter().chain([&summary]).all(|line| line.len() < 300));
    }

    #[test]
    fn a_kill_never_runs_while_the_child_lock_is_held() {
        let source = include_str!("pty.rs");
        for (index, _) in source.match_indices("child.lock()") {
            let tail = &source[index..];
            let statement_end = tail.find(';').unwrap_or(tail.len());
            let guard_scope = tail.find('{').unwrap_or(tail.len());
            if statement_end < guard_scope {
                continue;
            }
            let block_end = tail
                .find(
                    "
    }",
                )
                .unwrap_or(tail.len().min(600));
            let block = &tail[..block_end.min(600)];
            assert!(
                !block.contains("kill_process_tree("),
                "a child lock is held across kill_process_tree near byte {index};                  read the pid, release the lock, then kill"
            );
        }
    }

    /// The snapshot paths run under the global session lock, so they must never wait on a child.
    #[test]
    fn telemetry_never_waits_on_a_child_lock() {
        let source = include_str!("pty.rs");
        let snapshot = source
            .split("fn list_pty_processes")
            .nth(1)
            .expect("list_pty_processes exists");
        let body = &snapshot[..snapshot.len().min(2000)];
        assert!(
            !body.contains(
                ".child
                        .lock()"
            ),
            "the process snapshot must use try_lock: it holds the lock every keystroke needs"
        );
    }

    #[test]
    fn exit_reason_reports_exited_when_no_teardown_was_requested() {
        assert_eq!(exit_reason(TEARDOWN_NORMAL), "exited");
    }

    #[test]
    fn exit_reason_preserves_every_teardown_flag() {
        assert_eq!(exit_reason(TEARDOWN_KILLED), "killed");
        assert_eq!(exit_reason(TEARDOWN_SUSPENDED), "suspended");
        assert_eq!(exit_reason(TEARDOWN_RESTARTED), "restarted");
    }

    #[test]
    fn the_watcher_never_closes_a_session_whose_child_is_still_running() {
        assert!(!watcher_should_close(false, 0));
        assert!(!watcher_should_close(false, 10_000));
    }

    /// The child can die with its last lines still buffered, so closing on the spot would
    /// truncate an installer's or an agent's final output.
    #[test]
    fn the_watcher_waits_out_the_drain_grace_before_closing() {
        assert!(!watcher_should_close(true, 0));
        assert!(!watcher_should_close(true, 499));
        assert!(watcher_should_close(true, 500));
        assert!(watcher_should_close(true, 1_500));
    }

    /// Same invariant the kill path has: the snapshot and keystroke paths queue behind this lock,
    /// so the watcher may only peek at the child and must sleep with the guard released.
    #[test]
    fn the_child_watcher_never_holds_the_child_lock_across_a_wait() {
        let source = include_str!("pty.rs");
        let probe = source
            .split("fn child_has_exited")
            .nth(1)
            .expect("the watcher probe exists");
        let probe = &probe[..probe.find("\n}").unwrap_or(probe.len())];

        assert!(
            probe.contains("try_wait"),
            "the watcher must poll the child, never block on it"
        );
        assert!(
            !probe.contains("child.wait()"),
            "a blocking wait under the child lock stalls every terminal in the app"
        );
        assert!(
            !probe.contains("thread::sleep"),
            "the poll sleep must run outside the child lock"
        );
    }

    #[test]
    fn the_child_watcher_is_scoped_to_wsl_sessions() {
        let source = include_str!("pty.rs");
        let spawn = source
            .split("let watch_child_exit = wsl_target.is_some();")
            .nth(1)
            .expect("the watcher is gated on the WSL target");
        let body = &spawn[..spawn.len().min(600)];

        assert!(
            body.contains("if watch_child_exit {"),
            "the watcher thread must only be spawned for WSL sessions"
        );
        assert!(
            body.contains("child_has_exited"),
            "the gated block must be the one that polls the child"
        );
    }

    #[test]
    fn scrollback_cap_keeps_long_agent_chats() {
        assert!(SCROLLBACK_CAP_BYTES >= 4 * 1024 * 1024);
    }

    #[test]
    fn clearing_a_full_scrollback_releases_all_buffered_content() {
        let initial = VecDeque::from(vec![b'x'; SCROLLBACK_CAP_BYTES]);
        let mut buffer = ScrollbackBuffer::new(initial);
        buffer.pending = vec![b'y'; 256 * 1024];
        buffer.dirty = true;

        reset_scrollback_buffer(&mut buffer);

        assert!(buffer.data.is_empty());
        assert!(buffer.pending.is_empty());
        assert!(!buffer.dirty);
    }

    #[test]
    fn valid_utf8_prefix_passes_complete_ascii_and_multibyte() {
        assert_eq!(valid_utf8_prefix_len(b"hello"), 5);
        // "café" — o "é" são 2 bytes (0xC3 0xA9), todos presentes.
        let cafe = "café".as_bytes();
        assert_eq!(valid_utf8_prefix_len(cafe), cafe.len());
        // Box-drawing "─" (3 bytes) completo.
        let line = "─".as_bytes();
        assert_eq!(valid_utf8_prefix_len(line), 3);
    }

    #[test]
    fn valid_utf8_prefix_stops_before_split_multibyte() {
        // Primeiro byte de "é" sozinho (read partiu aqui) → 0 bytes válidos.
        assert_eq!(valid_utf8_prefix_len(&[0xC3]), 0);
        // "a" + primeiro byte de "é" → só o "a" é válido.
        assert_eq!(valid_utf8_prefix_len(&[b'a', 0xC3]), 1);
        // Emoji 😀 (4 bytes) com só os 2 primeiros → 0 válidos.
        let grin = "😀".as_bytes();
        assert_eq!(valid_utf8_prefix_len(&grin[..2]), 0);
    }

    #[test]
    fn activity_emit_due_fires_immediately_on_first_call() {
        assert!(activity_emit_due(None, PTY_ACTIVITY_EMIT_INTERVAL_MS));
    }

    #[test]
    fn activity_emit_due_throttles_until_interval_elapses() {
        let just_emitted = Instant::now();
        assert!(!activity_emit_due(
            Some(just_emitted),
            PTY_ACTIVITY_EMIT_INTERVAL_MS
        ));
        // Instant "no passado" simulado por um intervalo já vencido.
        let stale =
            Instant::now() - Duration::from_millis(PTY_ACTIVITY_EMIT_INTERVAL_MS as u64 + 1);
        assert!(activity_emit_due(
            Some(stale),
            PTY_ACTIVITY_EMIT_INTERVAL_MS
        ));
    }

    #[test]
    fn valid_utf8_prefix_carry_reassembles_split_char() {
        // Simula o split: "x" + "é" partido entre dois reads.
        let full = "xé".as_bytes(); // [b'x', 0xC3, 0xA9]
        let first = &full[..2]; // "x" + 0xC3
        let valid = valid_utf8_prefix_len(first);
        assert_eq!(valid, 1);
        // carry = [0xC3]; chega o resto do próximo read.
        let mut carry = first[valid..].to_vec();
        carry.extend_from_slice(&full[2..]); // + 0xA9
        assert_eq!(valid_utf8_prefix_len(&carry), carry.len());
    }
}
