/// Cross-platform child process detection.
///
/// Provides a single function `has_child_processes(pid)` that checks whether
/// the given process has any child processes, using platform-native APIs.

/// Returns `true` if the process identified by `pid` has at least one child process.
#[cfg(target_os = "macos")]
pub fn has_child_processes(pid: u32) -> bool {
    extern "C" {
        fn proc_listchildpids(ppid: i32, buffer: *mut i32, buffersize: i32) -> i32;
    }

    let mut buf: [i32; 1] = [0];
    // SAFETY: proc_listchildpids is a stable macOS libproc API. We pass a valid
    // stack-allocated buffer with its correct byte size. The function writes at
    // most `buffersize` bytes and returns the number of bytes written.
    let ret = unsafe {
        proc_listchildpids(
            pid as i32,
            buf.as_mut_ptr(),
            std::mem::size_of_val(&buf) as i32,
        )
    };
    ret > 0
}

/// Known interpreter basenames — when argv[0] is one of these, the actual
/// command name is in a later argv entry.
const INTERPRETERS: &[&str] = &["env", "node", "python", "python3", "ruby", "perl", "bash", "sh", "zsh"];

/// Read process argv via sysctl KERN_PROCARGS2 and return the effective command
/// basename. For directly-invoked binaries this is argv[0]'s basename. For
/// interpreter-launched scripts (`/usr/bin/env node /path/to/opencode`), this
/// skips the interpreter and its flags to find the script basename.
#[cfg(target_os = "macos")]
fn get_command_name(pid: i32) -> Option<String> {
    extern "C" {
        fn sysctl(
            name: *mut i32,
            namelen: u32,
            oldp: *mut std::ffi::c_void,
            oldlenp: *mut usize,
            newp: *mut std::ffi::c_void,
            newlen: usize,
        ) -> i32;
    }

    const CTL_KERN: i32 = 1;
    const KERN_PROCARGS2: i32 = 49;

    let mut mib = [CTL_KERN, KERN_PROCARGS2, pid];
    let mut size: usize = 0;

    // SAFETY: First call with null buffer to get required size.
    if unsafe { sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }
    if size == 0 { return None; }

    let mut buf = vec![0u8; size];
    // SAFETY: Second call fills the buffer with process arguments.
    if unsafe { sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr() as *mut _, &mut size, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }

    // Format: argc (4 bytes) | exec_path (null-terminated) | null padding | argv[0] | argv[1] | ...
    if size < 4 { return None; }
    let argc = i32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if argc < 1 { return None; }

    // Skip exec_path
    let mut pos = 4;
    while pos < size && buf[pos] != 0 { pos += 1; }
    // Skip null padding
    while pos < size && buf[pos] == 0 { pos += 1; }

    // Read all argv entries
    let mut args = Vec::with_capacity(argc);
    for _ in 0..argc {
        if pos >= size { break; }
        let start = pos;
        while pos < size && buf[pos] != 0 { pos += 1; }
        if let Ok(s) = std::str::from_utf8(&buf[start..pos]) {
            args.push(s.to_string());
        }
        pos += 1; // skip null terminator
    }

    // Find the first arg that isn't an interpreter or a flag.
    // e.g. ["/usr/bin/env", "node", "/usr/local/bin/opencode", "--version"]
    //       → skip "env", skip "node", return "opencode"
    for arg in &args {
        if arg.starts_with('-') { continue; } // skip flags
        let basename = arg.rsplit('/').next().unwrap_or(arg);
        if basename.is_empty() { continue; }
        if INTERPRETERS.contains(&basename) { continue; }
        return Some(basename.to_string());
    }

    None
}

/// Returns executable names of all direct child processes of the given PID.
/// Uses argv[0] basename so symlinked commands (e.g. `claude` → versioned binary)
/// report the name the user actually invoked.
#[cfg(target_os = "macos")]
pub fn get_child_process_names(pid: u32) -> Vec<String> {
    extern "C" {
        fn proc_listchildpids(ppid: i32, buffer: *mut i32, buffersize: i32) -> i32;
    }

    const MAX_CHILDREN: usize = 64;

    let mut child_pids = [0i32; MAX_CHILDREN];
    // SAFETY: proc_listchildpids writes child PIDs into the buffer and returns
    // the number of PIDs written (not bytes).
    let num_pids = unsafe {
        proc_listchildpids(
            pid as i32,
            child_pids.as_mut_ptr(),
            std::mem::size_of_val(&child_pids) as i32,
        )
    };
    if num_pids <= 0 {
        return Vec::new();
    }

    let count = (num_pids as usize).min(MAX_CHILDREN);
    let mut names = Vec::with_capacity(count);

    for &cpid in &child_pids[..count] {
        if let Some(name) = get_command_name(cpid) {
            names.push(name);
        }
    }
    names
}

/// Returns executable names of all direct child processes of the given PID.
#[cfg(target_os = "linux")]
pub fn get_child_process_names(pid: u32) -> Vec<String> {
    let mut child_pids = Vec::new();

    // Fast path: /proc/{pid}/task/{pid}/children
    let path = format!("/proc/{}/task/{}/children", pid, pid);
    if let Ok(contents) = std::fs::read_to_string(&path) {
        for token in contents.split_whitespace() {
            if let Ok(cpid) = token.parse::<u32>() {
                child_pids.push(cpid);
            }
        }
    }

    // Fallback: scan /proc/*/stat
    if child_pids.is_empty() {
        let entries = match std::fs::read_dir("/proc") {
            Ok(e) => e,
            Err(_) => return Vec::new(),
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let stat_path = format!("/proc/{}/stat", name);
            if let Ok(stat) = std::fs::read_to_string(&stat_path) {
                if let Some(after_comm) = stat.rfind(')') {
                    let fields: Vec<&str> = stat[after_comm + 1..].split_whitespace().collect();
                    if let Some(ppid_str) = fields.get(1) {
                        if ppid_str.parse::<u32>().ok() == Some(pid) {
                            if let Ok(cpid) = name.parse::<u32>() {
                                child_pids.push(cpid);
                            }
                        }
                    }
                }
            }
        }
    }

    child_pids
        .iter()
        .filter_map(|cpid| {
            // Parse cmdline (null-separated argv) and skip interpreters
            if let Ok(cmdline) = std::fs::read(format!("/proc/{}/cmdline", cpid)) {
                let args: Vec<&str> = cmdline
                    .split(|&b| b == 0)
                    .filter_map(|s| std::str::from_utf8(s).ok())
                    .filter(|s| !s.is_empty())
                    .collect();
                for arg in &args {
                    if arg.starts_with('-') { continue; }
                    let basename = arg.rsplit('/').next().unwrap_or(arg);
                    if basename.is_empty() { continue; }
                    if INTERPRETERS.contains(&basename) { continue; }
                    return Some(basename.to_string());
                }
            }
            // Fallback to comm
            std::fs::read_to_string(format!("/proc/{}/comm", cpid))
                .ok()
                .map(|s| s.trim().to_string())
        })
        .collect()
}

/// Returns `true` if the process identified by `pid` has at least one child process.
#[cfg(target_os = "linux")]
pub fn has_child_processes(pid: u32) -> bool {
    // Fast path: /proc/{pid}/task/{pid}/children (requires CONFIG_PROC_CHILDREN).
    // Note: this file is per-thread, so it may miss children spawned from
    // non-main threads. On miss, fall through to the /proc scan below.
    let path = format!("/proc/{}/task/{}/children", pid, pid);
    if let Ok(contents) = std::fs::read_to_string(&path) {
        if !contents.trim().is_empty() {
            return true;
        }
    }

    // Fallback: scan /proc/*/stat for processes whose ppid matches
    let entries = match std::fs::read_dir("/proc") {
        Ok(e) => e,
        Err(_) => return false,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let stat_path = format!("/proc/{}/stat", name);
        if let Ok(stat) = std::fs::read_to_string(&stat_path) {
            // Format: "pid (comm) state ppid ..." — find ppid after the last ')'
            if let Some(after_comm) = stat.rfind(')') {
                let fields: Vec<&str> = stat[after_comm + 1..].split_whitespace().collect();
                // fields[0] = state, fields[1] = ppid
                if let Some(ppid_str) = fields.get(1) {
                    if ppid_str.parse::<u32>().ok() == Some(pid) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// Script basenames that are generic entry-point names and do not reveal which
/// CLI tool is being run (e.g. `cli.js`, `index.js`). When the first
/// non-interpreter argument resolves to one of these, we fall back to
/// `package.json` lookup.
#[cfg(any(target_os = "windows", test))]
const GENERIC_SCRIPT_STEMS: &[&str] = &["cli", "index", "main", "app", "bin", "server", "run"];

/// Given a parsed argv (e.g. from a Windows process command line), skip
/// interpreters and flags to find the effective command name.  For Node.js
/// scripts with generic basenames (e.g. `cli.js`) this falls back to reading
/// `package.json` to discover the real bin name.
#[cfg(any(target_os = "windows", test))]
fn resolve_command_name_from_args(args: &[String]) -> Option<String> {
    for arg in args {
        if arg.starts_with('-') {
            continue;
        }
        // Normalise both `/` and `\` separators for basename extraction
        let basename = arg.rsplit(|c| c == '/' || c == '\\').next().unwrap_or(arg);
        if basename.is_empty() {
            continue;
        }
        // Strip known extensions to get the stem (.exe first for Windows
        // executables like node.exe, then script extensions like .js/.py)
        let stem = basename
            .strip_suffix(".exe")
            .or_else(|| basename.strip_suffix(".js"))
            .or_else(|| basename.strip_suffix(".mjs"))
            .or_else(|| basename.strip_suffix(".cjs"))
            .or_else(|| basename.strip_suffix(".ts"))
            .or_else(|| basename.strip_suffix(".py"))
            .unwrap_or(basename);
        let stem_lower = stem.to_ascii_lowercase();
        if INTERPRETERS.contains(&stem_lower.as_str()) {
            continue;
        }
        // Generic entry-point name → try package.json resolution
        if GENERIC_SCRIPT_STEMS.contains(&stem_lower.as_str()) {
            let path = std::path::Path::new(arg.as_str());
            if let Some(name) = resolve_from_package_json(path) {
                return Some(name);
            }
            // If package.json lookup failed, continue scanning remaining args
            continue;
        }
        return Some(stem.to_string());
    }
    None
}

/// Walk up from `script_path` looking for a `package.json` whose `bin` field
/// maps back to the script.  Returns the command name (the key in the `bin`
/// object, or the package name when `bin` is a plain string).
#[cfg(any(target_os = "windows", test))]
fn resolve_from_package_json(script_path: &std::path::Path) -> Option<String> {
    let script_path = dunce_canonicalize_or_clean(script_path);
    let mut dir = script_path.parent()?;
    for _ in 0..6 {
        let pkg_path = dir.join("package.json");
        if pkg_path.is_file() {
            if let Ok(contents) = std::fs::read_to_string(&pkg_path) {
                if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&contents) {
                    return extract_bin_name(&pkg, &script_path, dir);
                }
            }
        }
        dir = match dir.parent() {
            Some(d) => d,
            None => break,
        };
    }
    None
}

/// Best-effort path canonicalisation that avoids UNC prefix on Windows.
#[cfg(any(target_os = "windows", test))]
fn dunce_canonicalize_or_clean(path: &std::path::Path) -> std::path::PathBuf {
    // Try real canonicalization first; fall back to the original path.
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Extract the bin command name from a parsed `package.json` value.
#[cfg(any(target_os = "windows", test))]
fn extract_bin_name(
    pkg: &serde_json::Value,
    script_path: &std::path::Path,
    pkg_dir: &std::path::Path,
) -> Option<String> {
    match pkg.get("bin") {
        Some(serde_json::Value::Object(map)) => {
            for (cmd, val) in map {
                if let Some(rel) = val.as_str() {
                    let bin_path = dunce_canonicalize_or_clean(&pkg_dir.join(rel));
                    if paths_match(&bin_path, script_path) {
                        return Some(cmd.clone());
                    }
                }
            }
            None
        }
        Some(serde_json::Value::String(_)) => {
            // `"bin": "./cli.js"` — command name comes from the package name.
            let name = pkg.get("name")?.as_str()?;
            // Strip npm scope: "@anthropic-ai/claude-code" → "claude-code"
            let unscoped = name.rsplit('/').next().unwrap_or(name);
            Some(unscoped.to_string())
        }
        _ => None,
    }
}

/// Compare two paths after normalising separators.
#[cfg(any(target_os = "windows", test))]
fn paths_match(a: &std::path::Path, b: &std::path::Path) -> bool {
    // Use platform-native comparison; on Windows this is case-insensitive via
    // the canonicalized paths.
    a == b
}

/// Read the command line of a Windows process.
///
/// Uses two strategies:
/// 1. `NtQueryInformationProcess` with `ProcessCommandLineInformation` (Win10+)
/// 2. Fallback: read the PEB → ProcessParameters → CommandLine via
///    `ReadProcessMemory` (works on all Windows versions).
#[cfg(target_os = "windows")]
fn get_process_command_line(pid: u32) -> Option<String> {
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
    const PROCESS_VM_READ: u32 = 0x0010;

    extern "system" {
        fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> isize;
        fn CloseHandle(hObject: isize) -> i32;
        fn ReadProcessMemory(
            hProcess: isize,
            lpBaseAddress: usize,
            lpBuffer: *mut u8,
            nSize: usize,
            lpNumberOfBytesRead: *mut usize,
        ) -> i32;
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryInformationProcess(
            ProcessHandle: isize,
            ProcessInformationClass: u32,
            ProcessInformation: *mut u8,
            ProcessInformationLength: u32,
            ReturnLength: *mut u32,
        ) -> i32;
    }

    // ---- Strategy 1: ProcessCommandLineInformation (info class 60) ----
    // Returns a UNICODE_STRING whose Buffer points into the output buffer.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle != 0 {
            let mut buf = vec![0u8; 8192];
            let mut ret_len: u32 = 0;
            let status = NtQueryInformationProcess(
                handle, 60, // ProcessCommandLineInformation
                buf.as_mut_ptr(), buf.len() as u32, &mut ret_len,
            );
            if status == 0 {
                // UNICODE_STRING.Length is at offset 0 (2 bytes)
                let length = u16::from_ne_bytes([buf[0], buf[1]]) as usize;
                if length > 0 {
                    // Read the Buffer pointer from the UNICODE_STRING to find
                    // where the string data actually lives in our buffer.
                    let ptr_size = std::mem::size_of::<usize>();
                    // Buffer field offset: 4 bytes (Length + MaxLength) + padding
                    let ptr_offset = if ptr_size == 8 { 8 } else { 4 };
                    let mut ptr_bytes = [0u8; 8];
                    ptr_bytes[..ptr_size].copy_from_slice(&buf[ptr_offset..ptr_offset + ptr_size]);
                    let buffer_addr = usize::from_ne_bytes(ptr_bytes);
                    let buf_addr = buf.as_ptr() as usize;
                    // The Buffer pointer should point into our buf allocation
                    if let Some(str_offset) = buffer_addr.checked_sub(buf_addr) {
                        if str_offset + length <= buf.len() {
                            let str_bytes = &buf[str_offset..str_offset + length];
                            let chars: Vec<u16> = str_bytes
                                .chunks_exact(2)
                                .map(|c| u16::from_ne_bytes([c[0], c[1]]))
                                .collect();
                            let result = String::from_utf16_lossy(&chars);
                            CloseHandle(handle);
                            return Some(result);
                        }
                    }
                }
            }
            CloseHandle(handle);
        }
    }

    // ---- Strategy 2: PEB → ProcessParameters → CommandLine ----
    // More widely compatible; requires PROCESS_QUERY_INFORMATION | PROCESS_VM_READ.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
        if handle == 0 {
            return None;
        }

        // Step 1: Get PEB base address via ProcessBasicInformation (class 0).
        // PROCESS_BASIC_INFORMATION (x64): 48 bytes, PebBaseAddress at offset 8.
        let pbi_size: u32 = 48;
        let mut pbi = vec![0u8; pbi_size as usize];
        let mut ret_len: u32 = 0;
        let status = NtQueryInformationProcess(
            handle, 0, // ProcessBasicInformation
            pbi.as_mut_ptr(), pbi_size, &mut ret_len,
        );
        if status != 0 {
            CloseHandle(handle);
            return None;
        }

        let ptr_size = std::mem::size_of::<usize>();
        let peb_addr = read_ptr(&pbi, 8, ptr_size)?;

        // Step 2: Read ProcessParameters pointer from PEB.
        // PEB.ProcessParameters offset: 0x20 (x64) / 0x10 (x86).
        let params_offset: usize = if ptr_size == 8 { 0x20 } else { 0x10 };
        let mut ptr_buf = vec![0u8; ptr_size];
        let mut bytes_read: usize = 0;
        if ReadProcessMemory(
            handle, peb_addr + params_offset,
            ptr_buf.as_mut_ptr(), ptr_size, &mut bytes_read,
        ) == 0 {
            CloseHandle(handle);
            return None;
        }
        let params_addr = read_ptr(&ptr_buf, 0, ptr_size)?;

        // Step 3: Read CommandLine UNICODE_STRING from RTL_USER_PROCESS_PARAMETERS.
        // CommandLine offset: 0x70 (x64) / 0x40 (x86).
        let cmdline_offset: usize = if ptr_size == 8 { 0x70 } else { 0x40 };
        // UNICODE_STRING: Length(2) + MaxLength(2) + [padding] + Buffer(ptr_size)
        let us_size = if ptr_size == 8 { 16 } else { 8 };
        let mut us_buf = vec![0u8; us_size];
        if ReadProcessMemory(
            handle, params_addr + cmdline_offset,
            us_buf.as_mut_ptr(), us_size, &mut bytes_read,
        ) == 0 {
            CloseHandle(handle);
            return None;
        }

        let length = u16::from_ne_bytes([us_buf[0], us_buf[1]]) as usize;
        if length == 0 {
            CloseHandle(handle);
            return None;
        }
        let buffer_ptr_offset = if ptr_size == 8 { 8 } else { 4 };
        let buffer_addr = read_ptr(&us_buf, buffer_ptr_offset, ptr_size)?;

        // Step 4: Read the actual command line string.
        let mut str_buf = vec![0u8; length];
        if ReadProcessMemory(
            handle, buffer_addr,
            str_buf.as_mut_ptr(), length, &mut bytes_read,
        ) == 0 {
            CloseHandle(handle);
            return None;
        }

        CloseHandle(handle);

        let chars: Vec<u16> = str_buf
            .chunks_exact(2)
            .map(|c| u16::from_ne_bytes([c[0], c[1]]))
            .collect();
        Some(String::from_utf16_lossy(&chars))
    }
}

/// Helper: read a pointer-sized value from a byte buffer at the given offset.
#[cfg(target_os = "windows")]
fn read_ptr(buf: &[u8], offset: usize, ptr_size: usize) -> Option<usize> {
    if offset + ptr_size > buf.len() {
        return None;
    }
    if ptr_size == 8 {
        Some(usize::from_ne_bytes(
            buf[offset..offset + 8].try_into().ok()?,
        ))
    } else {
        Some(u32::from_ne_bytes(
            buf[offset..offset + 4].try_into().ok()?,
        ) as usize)
    }
}

/// Split a Windows command line into individual arguments using
/// CommandLineToArgvW from shell32.
#[cfg(target_os = "windows")]
fn parse_windows_command_line(cmdline: &str) -> Vec<String> {
    extern "system" {
        fn CommandLineToArgvW(lpCmdLine: *const u16, pNumArgs: *mut i32) -> *mut *mut u16;
        fn LocalFree(hMem: *mut u8) -> *mut u8;
    }

    let wide: Vec<u16> = cmdline.encode_utf16().chain(std::iter::once(0)).collect();
    let mut argc: i32 = 0;

    unsafe {
        let argv = CommandLineToArgvW(wide.as_ptr(), &mut argc);
        if argv.is_null() {
            return Vec::new();
        }

        let mut args = Vec::with_capacity(argc as usize);
        for i in 0..argc as isize {
            let ptr = *argv.offset(i);
            let mut len = 0;
            while *ptr.offset(len) != 0 {
                len += 1;
            }
            let slice = std::slice::from_raw_parts(ptr, len as usize);
            args.push(String::from_utf16_lossy(slice));
        }

        LocalFree(argv as *mut u8);
        args
    }
}

/// Resolve a single child process to its effective command name.
/// For interpreter processes (node, python, …) this reads the process command
/// line and resolves the script name.  For native binaries it returns the exe
/// basename directly.
#[cfg(target_os = "windows")]
fn resolve_child_name(child_pid: u32, exe_name: &str) -> String {
    let base = exe_name.strip_suffix(".exe").unwrap_or(exe_name);
    let base_lower = base.to_ascii_lowercase();
    if !INTERPRETERS.contains(&base_lower.as_str()) {
        eprintln!("[process_monitor] pid={child_pid} exe={exe_name:?} → not interpreter, returning {base:?}");
        return base.to_string();
    }
    // Interpreter process — try to resolve via command line
    match get_process_command_line(child_pid) {
        Some(cmdline) => {
            let args = parse_windows_command_line(&cmdline);
            eprintln!("[process_monitor] pid={child_pid} exe={exe_name:?} cmdline args={args:?}");
            if let Some(resolved) = resolve_command_name_from_args(&args) {
                eprintln!("[process_monitor] pid={child_pid} → resolved to {resolved:?}");
                return resolved;
            }
            eprintln!("[process_monitor] pid={child_pid} → resolve_command_name_from_args returned None, falling back to {base:?}");
        }
        None => {
            eprintln!("[process_monitor] pid={child_pid} exe={exe_name:?} → get_process_command_line returned None");
        }
    }
    base.to_string()
}

/// Returns executable names of all direct child processes of the given PID.
/// For interpreter processes (node.exe, python.exe, …) this reads the process
/// command line to determine the actual CLI tool being run, mirroring the
/// argv-based detection that macOS and Linux use.
#[cfg(target_os = "windows")]
pub fn get_child_process_names(pid: u32) -> Vec<String> {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::mem;

    const TH32CS_SNAPPROCESS: u32 = 0x00000002;
    const INVALID_HANDLE_VALUE: isize = -1;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct PROCESSENTRY32W {
        dwSize: u32,
        cntUsage: u32,
        th32ProcessID: u32,
        th32DefaultHeapID: usize,
        th32ModuleID: u32,
        cntThreads: u32,
        th32ParentProcessID: u32,
        pcPriClassBase: i32,
        dwFlags: u32,
        szExeFile: [u16; 260],
    }

    extern "system" {
        fn CreateToolhelp32Snapshot(dwFlags: u32, th32ProcessID: u32) -> isize;
        fn Process32FirstW(hSnapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn Process32NextW(hSnapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn CloseHandle(hObject: isize) -> i32;
    }

    // Per-thread cache: PID → resolved command name.  Avoids repeated
    // NtQueryInformationProcess + package.json reads on every 100ms poll.
    thread_local! {
        static NAME_CACHE: RefCell<HashMap<u32, String>> = RefCell::new(HashMap::new());
    }

    // Collect all process entries from the snapshot so we can look up both
    // direct children and grandchildren (for cmd.exe intermediaries).
    struct ProcEntry {
        pid: u32,
        parent_pid: u32,
        exe_name: String,
    }

    let mut entries: Vec<ProcEntry> = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Vec::new();
        }

        let mut entry: PROCESSENTRY32W = mem::zeroed();
        entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;

        if Process32FirstW(snapshot, &mut entry) == 0 {
            CloseHandle(snapshot);
            return Vec::new();
        }

        loop {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(260);
            let exe = String::from_utf16_lossy(&entry.szExeFile[..len]);
            entries.push(ProcEntry {
                pid: entry.th32ProcessID,
                parent_pid: entry.th32ParentProcessID,
                exe_name: exe,
            });
            if Process32NextW(snapshot, &mut entry) == 0 {
                break;
            }
        }

        CloseHandle(snapshot);
    }

    // Intermediary exe names that are transparent wrappers — when one of these
    // is a child process we look through it at its own children instead.
    const INTERMEDIARIES: &[&str] = &["cmd", "bash", "sh", "zsh", "pwsh", "powershell", "wsl", "env"];

    /// Check if an exe basename (without .exe) is an intermediary we should
    /// look through rather than report.
    fn is_intermediary(base: &str) -> bool {
        INTERMEDIARIES.iter().any(|i| base.eq_ignore_ascii_case(i))
    }

    let mut names = Vec::new();
    let mut seen_pids: Vec<u32> = Vec::new();

    // BFS through the process tree starting from `pid`.  We walk through
    // intermediary processes (cmd.exe, bash.exe, …) transparently because
    // MSYS2/Git Bash inserts forked-bash processes between the shell and the
    // actual command.  Max depth prevents runaway traversal.
    const MAX_DEPTH: u8 = 4;
    // (parent_pid, depth)
    let mut queue: Vec<(u32, u8)> = vec![(pid, 0)];

    eprintln!("[process_monitor] get_child_process_names(pid={pid}), {} entries in snapshot", entries.len());

    // Dump all node.exe / python.exe / copilot.exe processes to see where they
    // actually sit in the Windows process tree.
    for e in &entries {
        let lower = e.exe_name.to_ascii_lowercase();
        if lower.contains("node") || lower.contains("python") || lower.contains("copilot")
            || lower.contains("claude") || lower.contains("opencode") || lower.contains("gemini")
            || lower.contains("aider") || lower.contains("codex") || lower.contains("conhost")
        {
            eprintln!("[process_monitor]   INTERESTING: exe={:?} pid={} ppid={}", e.exe_name, e.pid, e.parent_pid);
        }
    }

    while let Some((parent, depth)) = queue.pop() {
        if depth >= MAX_DEPTH {
            continue;
        }
        let children: Vec<&ProcEntry> = entries.iter().filter(|e| e.parent_pid == parent).collect();
        if !children.is_empty() {
            eprintln!("[process_monitor]   depth={depth} parent={parent} children: {:?}",
                children.iter().map(|c| format!("{}({})", c.exe_name, c.pid)).collect::<Vec<_>>());
        }
        for entry in children {
            let base = entry.exe_name.strip_suffix(".exe").unwrap_or(&entry.exe_name);

            if is_intermediary(base) {
                // Transparent intermediary — look through it at its children.
                eprintln!("[process_monitor]   → {base:?} is intermediary, looking through pid={}", entry.pid);
                queue.push((entry.pid, depth + 1));
                seen_pids.push(entry.pid);
                continue;
            }

            seen_pids.push(entry.pid);
            let resolved = NAME_CACHE.with(|cache| {
                let mut cache = cache.borrow_mut();
                if let Some(cached) = cache.get(&entry.pid) {
                    return cached.clone();
                }
                let name = resolve_child_name(entry.pid, &entry.exe_name);
                cache.insert(entry.pid, name.clone());
                name
            });
            names.push(resolved);
        }
    }

    // Evict stale PIDs from the cache
    NAME_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        cache.retain(|pid, _| seen_pids.contains(pid));
    });

    names
}

/// Returns `true` if the process identified by `pid` has at least one child process.
#[cfg(target_os = "windows")]
pub fn has_child_processes(pid: u32) -> bool {
    use std::mem;

    // Windows API constants
    const TH32CS_SNAPPROCESS: u32 = 0x00000002;
    const INVALID_HANDLE_VALUE: isize = -1;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct PROCESSENTRY32W {
        dwSize: u32,
        cntUsage: u32,
        th32ProcessID: u32,
        th32DefaultHeapID: usize,
        th32ModuleID: u32,
        cntThreads: u32,
        th32ParentProcessID: u32,
        pcPriClassBase: i32,
        dwFlags: u32,
        szExeFile: [u16; 260],
    }

    extern "system" {
        fn CreateToolhelp32Snapshot(dwFlags: u32, th32ProcessID: u32) -> isize;
        fn Process32FirstW(hSnapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn Process32NextW(hSnapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn CloseHandle(hObject: isize) -> i32;
    }

    // SAFETY: We use the Windows Toolhelp API to enumerate processes. The snapshot
    // handle is closed in all code paths. PROCESSENTRY32W is zero-initialized with
    // dwSize set correctly before the first call, as required by the API contract.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return false;
        }

        let mut entry: PROCESSENTRY32W = mem::zeroed();
        entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;

        if Process32FirstW(snapshot, &mut entry) == 0 {
            CloseHandle(snapshot);
            return false;
        }

        loop {
            if entry.th32ParentProcessID == pid {
                CloseHandle(snapshot);
                return true;
            }
            if Process32NextW(snapshot, &mut entry) == 0 {
                break;
            }
        }

        CloseHandle(snapshot);
        false
    }
}

/// Fallback for unsupported platforms — always returns empty vec.
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub fn get_child_process_names(_pid: u32) -> Vec<String> {
    Vec::new()
}

/// Fallback for unsupported platforms — always returns `false`.
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub fn has_child_processes(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_process_returns_without_panic() {
        let pid = std::process::id();
        // Just verify the function doesn't panic — the test runner may or may
        // not have child processes depending on parallel test execution.
        let _ = has_child_processes(pid);
    }

    #[cfg(unix)]
    #[test]
    fn detects_spawned_child() {
        use std::process::Command;
        let child = Command::new("sleep").arg("10").spawn().expect("failed to spawn sleep");
        let pid = std::process::id();
        assert!(has_child_processes(pid));
        // Clean up
        let mut child = child;
        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn nonexistent_pid_returns_false() {
        // An absurdly high PID that almost certainly doesn't exist.
        assert!(!has_child_processes(u32::MAX));
    }

    #[cfg(unix)]
    #[test]
    fn get_child_names_includes_spawned_process() {
        use std::process::Command;
        let child = Command::new("sleep").arg("10").spawn().expect("failed to spawn sleep");
        let pid = std::process::id();
        // Allow the process to fully start so the OS can report its name
        std::thread::sleep(std::time::Duration::from_millis(50));
        let names = get_child_process_names(pid);
        assert!(names.iter().any(|n| n == "sleep"), "expected 'sleep' in {:?}", names);
        let mut child = child;
        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn get_child_names_empty_for_nonexistent_pid() {
        assert!(get_child_process_names(u32::MAX).is_empty());
    }

    // --- resolve_command_name_from_args tests ---

    #[test]
    fn resolve_args_native_binary() {
        let args = vec!["opencode".to_string()];
        assert_eq!(resolve_command_name_from_args(&args), Some("opencode".into()));
    }

    #[test]
    fn resolve_args_node_with_named_script() {
        // On macOS/Linux the symlink name is passed: `node /usr/local/bin/claude`
        let args = vec!["node".into(), "/usr/local/bin/claude".into()];
        assert_eq!(resolve_command_name_from_args(&args), Some("claude".into()));
    }

    #[test]
    fn resolve_args_python_with_flags() {
        let args = vec!["python".into(), "-u".into(), "/home/user/.local/bin/aider".into()];
        assert_eq!(resolve_command_name_from_args(&args), Some("aider".into()));
    }

    #[test]
    fn resolve_args_node_with_js_extension() {
        // Script with a non-generic name and .js extension
        let args = vec!["node".into(), "/path/to/gemini.js".into()];
        assert_eq!(resolve_command_name_from_args(&args), Some("gemini".into()));
    }

    #[test]
    fn resolve_args_skips_env_and_interpreter() {
        let args = vec!["env".into(), "node".into(), "/usr/bin/codex".into()];
        assert_eq!(resolve_command_name_from_args(&args), Some("codex".into()));
    }

    #[test]
    fn resolve_args_node_exe_with_flag_and_script() {
        // Windows: node.exe in argv[0] must be recognised as an interpreter
        let args = vec![
            "C:\\Program Files\\nodejs\\node.exe".into(),
            "--no-warnings=DEP0040".into(),
            "C:\\Users\\X\\AppData\\Roaming\\npm/node_modules/opencode-ai/bin/opencode".into(),
        ];
        assert_eq!(resolve_command_name_from_args(&args), Some("opencode".into()));
    }

    #[test]
    fn resolve_args_windows_backslash_paths() {
        let args = vec![
            "node".into(),
            "C:\\Users\\X\\AppData\\Roaming\\npm\\node_modules\\opencode\\bin\\opencode".into(),
        ];
        assert_eq!(resolve_command_name_from_args(&args), Some("opencode".into()));
    }

    #[test]
    fn resolve_args_generic_cli_js_without_package_json() {
        // Generic name `cli.js` but no package.json on disk → None (skip, then no more args)
        let args = vec!["node".into(), "/nonexistent/path/cli.js".into()];
        assert_eq!(resolve_command_name_from_args(&args), None);
    }

    #[test]
    fn resolve_args_empty() {
        assert_eq!(resolve_command_name_from_args(&[]), None);
    }

    #[test]
    fn resolve_args_only_interpreters() {
        let args = vec!["env".into(), "node".into()];
        assert_eq!(resolve_command_name_from_args(&args), None);
    }

    // --- resolve_from_package_json tests ---

    #[test]
    fn resolve_package_json_bin_object() {
        let dir = std::env::temp_dir().join("abundio_test_pkg_obj");
        let dist = dir.join("dist");
        let _ = std::fs::create_dir_all(&dist);
        // Write a dummy script file so canonicalize works
        std::fs::write(dist.join("cli.js"), "").unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{"name": "@anthropic-ai/claude-code", "bin": {"claude": "./dist/cli.js"}}"#,
        )
        .unwrap();

        let script = dist.join("cli.js");
        let result = resolve_from_package_json(&script);
        assert_eq!(result, Some("claude".into()));

        // Cleanup
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_package_json_bin_string() {
        let dir = std::env::temp_dir().join("abundio_test_pkg_str");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("cli.js"), "").unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{"name": "@google/gemini-cli", "bin": "./cli.js"}"#,
        )
        .unwrap();

        let script = dir.join("cli.js");
        let result = resolve_from_package_json(&script);
        assert_eq!(result, Some("gemini-cli".into()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_package_json_missing() {
        let path = std::path::Path::new("/nonexistent/deeply/nested/cli.js");
        assert_eq!(resolve_from_package_json(path), None);
    }

    #[test]
    fn resolve_package_json_malformed() {
        let dir = std::env::temp_dir().join("abundio_test_pkg_bad");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("cli.js"), "").unwrap();
        std::fs::write(dir.join("package.json"), "NOT JSON").unwrap();

        let script = dir.join("cli.js");
        assert_eq!(resolve_from_package_json(&script), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_package_json_nested_dist() {
        // package.json is one level above the script's directory
        let dir = std::env::temp_dir().join("abundio_test_pkg_nested");
        let dist = dir.join("dist").join("src");
        let _ = std::fs::create_dir_all(&dist);
        std::fs::write(dist.join("index.js"), "").unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{"name": "codex", "bin": {"codex": "./dist/src/index.js"}}"#,
        )
        .unwrap();

        let script = dist.join("index.js");
        let result = resolve_from_package_json(&script);
        assert_eq!(result, Some("codex".into()));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
