use crate::shell_env;

/// Generates a shell hook setup string that:
/// 1. Disables echo so the setup and subsequent commands don't appear in the terminal
/// 2. Defines a precmd/PROMPT_COMMAND hook emitting OSC 7337 with JSON metadata
/// 3. Sets PS1 to a minimal value so the shell prompt doesn't clutter xterm output
///
/// Everything is sent as a single compound command so the shell only processes
/// one line — nothing is visible in the terminal since stty -echo leads.
///
/// The OSC sequence format is:
///   \x1b]7337;{"cwd":"...","git":"...","user":"...","exit":N,"elapsed":"..."}\x07
///
/// The frontend parses these sequences from PTY output to update the PowerlinePrompt.
pub fn hook_setup_command() -> String {
    let shell = shell_env::default_shell();

    if shell.contains("zsh") {
        zsh_hooks()
    } else if shell.contains("bash") {
        bash_hooks()
    } else {
        String::new()
    }
}

fn zsh_hooks() -> String {
    // Single compound command: stty -echo first so nothing after it is visible.
    // All definitions joined with ; on one line.
    [
        "stty -echo;",
        "PROMPT_EOL_MARK='';",
        "abundio_preexec() { _abundio_cmd_start=$EPOCHSECONDS; };",
        "abundio_precmd() { ",
            "local ec=$?; ",
            "stty -echo 2>/dev/null; ",
            "local el=\"\"; ",
            "if [[ -n \"$_abundio_cmd_start\" ]]; then ",
                "local -i d=$((EPOCHSECONDS - _abundio_cmd_start)); ",
                "if (( d >= 3600 )); then el=\"$((d/3600))h$((d%3600/60))m\"; ",
                "elif (( d >= 60 )); then el=\"$((d/60))m$((d%60))s\"; ",
                "elif (( d > 0 )); then el=\"${d}s\"; fi; fi; ",
            "unset _abundio_cmd_start; ",
            "local gb=\"$(git branch --show-current 2>/dev/null)\"; ",
            "printf '\\033]7337;{\"cwd\":\"%s\",\"git\":\"%s\",\"user\":\"%s@%s\",\"exit\":%d,\"elapsed\":\"%s\"}\\007' ",
                "\"$PWD\" \"$gb\" \"$USER\" \"$(hostname -s)\" \"$ec\" \"$el\"; ",
        "};",
        "autoload -Uz add-zsh-hook;",
        "add-zsh-hook preexec abundio_preexec;",
        "add-zsh-hook precmd abundio_precmd;",
        "PS1=' '",
        "\r",
    ]
    .join("")
}

fn bash_hooks() -> String {
    [
        "stty -echo;",
        "_abundio_preexec_trap() { _abundio_cmd_start=$SECONDS; };",
        "trap '_abundio_preexec_trap' DEBUG;",
        "_abundio_prompt_cmd() { ",
            "local ec=$?; ",
            "stty -echo 2>/dev/null; ",
            "local el=\"\"; ",
            "if [ -n \"$_abundio_cmd_start\" ]; then ",
                "local d=$(( ${SECONDS%.*} - ${_abundio_cmd_start%.*} )); ",
                "if [ $d -ge 3600 ]; then el=\"$((d/3600))h$((d%3600/60))m\"; ",
                "elif [ $d -ge 60 ]; then el=\"$((d/60))m$((d%60))s\"; ",
                "elif [ $d -gt 0 ]; then el=\"${d}s\"; fi; fi; ",
            "unset _abundio_cmd_start; ",
            "local gb=\"$(git branch --show-current 2>/dev/null)\"; ",
            "printf '\\033]7337;{\"cwd\":\"%s\",\"git\":\"%s\",\"user\":\"%s@%s\",\"exit\":%d,\"elapsed\":\"%s\"}\\007' ",
                "\"$PWD\" \"$gb\" \"$USER\" \"$(hostname -s)\" \"$ec\" \"$el\"; ",
        "};",
        "PROMPT_COMMAND='_abundio_prompt_cmd';",
        "PS1=' '",
        "\r",
    ]
    .join("")
}
