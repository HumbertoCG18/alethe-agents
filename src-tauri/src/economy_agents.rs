// Agent canvas phase 3 — economy mode.

use std::fs;
use std::path::PathBuf;

const MARKER: &str = "gerado pelo Alethe (modo economia)";

const AGENTS: &[(&str, &str)] = &[
    (
        "haiku-resumidor.md",
        r#"---
name: haiku-resumidor
description: MUST BE USED para resumir arquivos, extrair informação específica, classificar conteúdo e varrer logs. Use proativamente sempre que precisar ler muito conteúdo e só o resumo ou um dado pontual importar.
model: haiku
tools: Read, Grep, Glob
---

Você é um worker de leitura barato. Sua única função é ler muito e devolver pouco.

Regras:
- Responda SEMPRE em formato curto e estruturado: bullets, no máximo ~150 palavras.
- Nunca cole trechos longos do conteúdo lido; extraia só o que foi pedido.
- Se a tarefa pedir um dado específico (número, nome, path), devolva só ele.
- Não tome decisões de arquitetura nem sugira refactors — só reporte fatos.

<!-- gerado pelo Alethe (modo economia) — seguro deletar -->
"#,
    ),
    (
        "haiku-mecanico.md",
        r#"---
name: haiku-mecanico
description: MUST BE USED para tarefas mecânicas de edição - gerar boilerplate, renomear símbolos, formatar, aplicar a mesma mudança repetitiva em vários arquivos. Use proativamente quando a tarefa for braçal, bem especificada e não exigir decisão de design.
model: haiku
tools: Read, Edit, Write, Grep, Glob
---

Você é um worker mecânico barato. Executa edições braçais exatamente como especificado.

Regras:
- Siga a especificação à risca; não "melhore" nada por conta própria.
- Em caso de ambiguidade, pare e devolva a dúvida em uma linha em vez de adivinhar.
- Resposta final: lista curta de arquivos tocados + uma linha do que mudou em cada.

<!-- gerado pelo Alethe (modo economia) — seguro deletar -->
"#,
    ),
    (
        // PreToolUse restricts the executor to `codex exec` and explains denials.
        "codex-only-guard.cjs",
        r#"                                                               
let raw = ''
process.stdin.on('data', (d) => (raw += d))
process.stdin.on('end', () => {
  let cmd = ''
  try {
    cmd = JSON.parse(raw).tool_input.command || ''
  } catch {}
  if (!/^\s*codex\s+exec\b/.test(cmd)) {
    console.error('Bloqueado: o codex-executor só pode rodar `codex exec ...`. Monte a tarefa como instrução autocontida e delega pro codex.')
    process.exit(2)
  }
  let quote = ''
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote === "'") {
      if (c === "'") quote = ''
    } else if (c === '\\') {
      i++
    } else if (c === '$' || c === '`' || (!quote && ';&|<>\r\n'.includes(c))) {
      console.error('Bloqueado: operadores e expansões de shell não são permitidos. Use `codex exec` com um prompt literal.')
      process.exit(2)
    } else if (c === quote) {
      quote = ''
    } else if (!quote && (c === "'" || c === '"')) {
      quote = c
    }
  }
  if (quote) {
    console.error('Bloqueado: aspas não terminadas no comando `codex exec`.')
    process.exit(2)
  }
})
"#,
    ),
    (
        "codex-executor.md",
        r#"---
name: codex-executor
description: EXPERIMENTAL - use para execução longa e barulhenta onde só o resumo importa - rodar suites de teste, builds demorados, aplicar um fix mecânico e verificar. O trabalho pesado roda no Codex CLI (GPT), fora do orçamento de tokens do Claude.
model: haiku
tools: Bash
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: node .claude/agents/codex-only-guard.cjs
---

Você é um proxy pro Codex CLI. O ÚNICO comando Bash que você está autorizado a rodar é `codex exec`. Rodar qualquer outro comando (find, grep, cat, npm, cargo…) é uma violação — mesmo que a tarefa pareça trivial, ela DEVE ir pro codex.

Como operar:
1. Monte a tarefa como uma instrução autocontida em inglês (o codex não vê esta conversa).
2. Rode: `codex exec --skip-git-repo-check "<instrução>"`.
3. Devolva APENAS: resultado em até 5 bullets + o que falhou, se falhou. Nunca cole a saída bruta inteira.

<!-- gerado pelo Alethe (modo economia) — seguro deletar -->
"#,
    ),
];

fn agents_dir(folder: &str) -> PathBuf {
    PathBuf::from(folder).join(".claude").join("agents")
}

#[tauri::command]
pub fn economy_agents_enabled(folder: String) -> bool {
    let dir = agents_dir(&folder);
    AGENTS.iter().all(|(name, _)| dir.join(name).is_file())
}

#[tauri::command]
pub fn set_economy_agents(folder: String, enabled: bool) -> Result<Vec<String>, String> {
    let dir = agents_dir(&folder);
    let mut touched = Vec::new();

    if enabled {
        fs::create_dir_all(&dir).map_err(|e| format!("criar {}: {e}", dir.display()))?;
        for (name, body) in AGENTS {
            let path = dir.join(name);
            fs::write(&path, body).map_err(|e| format!("escrever {}: {e}", path.display()))?;
            touched.push(path.to_string_lossy().to_string());
        }
        eprintln!(
            "[economy_agents] {} agents escritos em {}",
            AGENTS.len(),
            dir.display()
        );
    } else {
        for (name, _) in AGENTS {
            let path = dir.join(name);
            let ours = fs::read_to_string(&path)
                .map(|c| c.contains(MARKER))
                .unwrap_or(false);
            if ours {
                fs::remove_file(&path).map_err(|e| format!("remover {}: {e}", path.display()))?;
                touched.push(path.to_string_lossy().to_string());
            }
        }
        eprintln!(
            "[economy_agents] {} agents removidos de {}",
            touched.len(),
            dir.display()
        );
    }

    Ok(touched)
}

#[cfg(test)]
mod tests {
    use super::AGENTS;
    use std::fs;
    use std::io::Write;
    use std::process::{Command, Stdio};

    fn assert_hook(input: &str, expected: i32) {
        let body = AGENTS
            .iter()
            .find(|(name, _)| *name == "codex-only-guard.cjs")
            .expect("embedded guard must exist")
            .1;
        let path =
            std::env::temp_dir().join(format!("alethe-codex-only-guard-{}.cjs", nanoid::nanoid!()));
        fs::write(&path, body).expect("write guard script");
        let output = (|| -> std::io::Result<_> {
            let mut child = Command::new("node")
                .arg(&path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()?;
            child.stdin.take().unwrap().write_all(input.as_bytes())?;
            child.wait_with_output()
        })();
        fs::remove_file(&path).expect("remove guard script");
        let output = output.expect("node must be on PATH and execute the guard successfully");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(
            output.status.code(),
            Some(expected),
            "hook input: {input:?}; stderr: {stderr}"
        );
        if expected == 2 {
            assert!(stderr.starts_with("Bloqueado:"), "missing reason: {stderr}");
        }
    }

    fn assert_command(command: &str, expected: i32) {
        let payload = serde_json::json!({ "tool_input": { "command": command } });
        assert_hook(&payload.to_string(), expected);
    }

    #[test]
    fn guard_allows_literal_prompt_text() {
        for command in [
            r#"codex exec --skip-git-repo-check "do x; then y | z > w""#,
            r#"codex exec '$HOME $(whoami) `whoami`; & | < >'"#,
            r#"codex exec 'literal \ and "quotes" $HOME'"#,
            r#"codex exec "literal ; & | < >""#,
            "codex exec 'line one\nline two\rline three'",
            "codex exec \"line one\nline two\rline three\"",
        ] {
            assert_command(command, 0);
        }
    }

    #[test]
    fn guard_allows_escaped_characters() {
        for command in [
            r#"codex exec \;\&\|\<\>\`\$\'\""#,
            r#"codex exec "\$HOME \`whoami\` \"quoted\" \\""#,
        ] {
            assert_command(command, 0);
        }
    }

    #[test]
    fn guard_denies_semicolon() {
        for command in [
            r#"codex exec "x"; whoami"#,
            r#"codex exec x\\;whoami"#,
            r#"codex exec 'x\';whoami"#,
        ] {
            assert_command(command, 2);
        }
    }

    #[test]
    fn guard_denies_ampersand() {
        for command in [r#"codex exec "x" && whoami"#, "codex exec x & whoami"] {
            assert_command(command, 2);
        }
    }

    #[test]
    fn guard_denies_pipe() {
        for command in [r#"codex exec "x" | sh"#, "codex exec x || whoami"] {
            assert_command(command, 2);
        }
    }

    #[test]
    fn guard_denies_redirection() {
        for command in ["codex exec x < input", "codex exec x > output"] {
            assert_command(command, 2);
        }
    }

    #[test]
    fn guard_denies_unquoted_expansion() {
        for command in ["codex exec $HOME", "codex exec `whoami`"] {
            assert_command(command, 2);
        }
    }

    #[test]
    fn guard_denies_double_quoted_substitution() {
        assert_command(r#"codex exec "$(whoami)""#, 2);
    }

    #[test]
    fn guard_denies_double_quoted_environment_variable() {
        for command in [
            r#"codex exec "$OPENAI_API_KEY""#,
            r#"codex exec "\\$HOME""#,
            r#"codex exec "\"$HOME""#,
        ] {
            assert_command(command, 2);
        }
    }

    #[test]
    fn guard_denies_double_quoted_backtick() {
        assert_command(r#"codex exec "`whoami`""#, 2);
    }

    #[test]
    fn guard_denies_unquoted_newline() {
        for newline in ["\n", "\r", "\r\n"] {
            assert_command(&format!("codex exec x{newline}whoami"), 2);
        }
    }

    #[test]
    fn guard_denies_unterminated_quote() {
        for command in ["codex exec 'x", "codex exec \"x", r#"codex exec "x\""#] {
            assert_command(command, 2);
        }
    }

    #[test]
    fn guard_denies_non_codex_command() {
        assert_command("whoami", 2);
    }

    #[test]
    fn guard_denies_invalid_json() {
        for input in ["not JSON", "", "{"] {
            assert_hook(input, 2);
        }
    }
}
