use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::AbundioError;

pub struct SearchManager {
    cancel_flags: DashMap<String, Arc<AtomicBool>>,
}

impl SearchManager {
    pub fn new() -> Self {
        Self {
            cancel_flags: DashMap::new(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub root_path: String,
    pub query: String,
    pub case_sensitive: bool,
    pub is_regex: bool,
    pub whole_word: bool,
    pub include_pattern: Option<String>,
    pub exclude_pattern: Option<String>,
    pub max_results: Option<usize>,
    pub search_id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub line_number: usize,
    pub line_content: String,
    pub match_start: usize,
    pub match_end: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileResult {
    pub file_path: String,
    pub matches: Vec<SearchMatch>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub files: Vec<SearchFileResult>,
    pub total_matches: usize,
    pub truncated: bool,
}

const DEFAULT_MAX_RESULTS: usize = 10_000;
const MAX_FILE_SIZE: u64 = 5 * 1024 * 1024;
const BINARY_CHECK_LEN: usize = 8192;

fn has_null_bytes(data: &[u8]) -> bool {
    data.iter().any(|&b| b == 0)
}

fn build_regex(query: &str, case_sensitive: bool, is_regex: bool, whole_word: bool) -> Result<Regex, AbundioError> {
    let mut pattern = if is_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };

    if whole_word {
        pattern = format!(r"\b{}\b", pattern);
    }

    if !case_sensitive {
        pattern = format!("(?i){}", pattern);
    }

    Regex::new(&pattern).map_err(|e| AbundioError::Search(format!("Invalid regex: {}", e)))
}

fn search_file_contents(path: &str, re: &Regex, max_remaining: usize) -> Result<Option<SearchFileResult>, AbundioError> {
    let metadata = std::fs::metadata(path)?;
    if metadata.len() > MAX_FILE_SIZE || metadata.is_dir() {
        return Ok(None);
    }

    let bytes = std::fs::read(path)?;
    let check_len = bytes.len().min(BINARY_CHECK_LEN);
    if has_null_bytes(&bytes[..check_len]) {
        return Ok(None);
    }

    let text = String::from_utf8_lossy(&bytes);
    let mut matches = Vec::new();

    for (line_idx, line) in text.lines().enumerate() {
        if matches.len() >= max_remaining {
            break;
        }
        for mat in re.find_iter(line) {
            if matches.len() >= max_remaining {
                break;
            }
            matches.push(SearchMatch {
                line_number: line_idx + 1,
                line_content: line.to_string(),
                match_start: mat.start(),
                match_end: mat.end(),
            });
        }
    }

    if matches.is_empty() {
        Ok(None)
    } else {
        Ok(Some(SearchFileResult {
            file_path: path.to_string(),
            matches,
        }))
    }
}

#[tauri::command]
pub async fn fs_search(
    params: SearchQuery,
    manager: State<'_, SearchManager>,
) -> Result<SearchResult, AbundioError> {
    let cancel = Arc::new(AtomicBool::new(false));
    manager.cancel_flags.insert(params.search_id.clone(), cancel.clone());
    let search_id = params.search_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        let re = build_regex(&params.query, params.case_sensitive, params.is_regex, params.whole_word)?;
        let max_results = params.max_results.unwrap_or(DEFAULT_MAX_RESULTS);

        let mut overrides = OverrideBuilder::new(&params.root_path);

        if let Some(ref include) = params.include_pattern {
            for glob in include.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                overrides.add(glob).map_err(|e| AbundioError::Search(format!("Invalid include pattern '{}': {}", glob, e)))?;
            }
        }

        if let Some(ref exclude) = params.exclude_pattern {
            for glob in exclude.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                let negated = format!("!{}", glob);
                overrides.add(&negated).map_err(|e| AbundioError::Search(format!("Invalid exclude pattern '{}': {}", glob, e)))?;
            }
        }

        let overrides = overrides.build().map_err(|e| AbundioError::Search(format!("Failed to build override: {}", e)))?;

        let walker = WalkBuilder::new(&params.root_path)
            .overrides(overrides)
            .hidden(false)
            .build();

        let mut files: Vec<SearchFileResult> = Vec::new();
        let mut total_matches: usize = 0;
        let mut truncated = false;

        for entry in walker {
            if cancel.load(Ordering::Relaxed) {
                break;
            }

            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };

            if !entry.file_type().map_or(false, |ft| ft.is_file()) {
                continue;
            }

            let path = entry.path().to_string_lossy().to_string();
            let remaining = max_results.saturating_sub(total_matches);
            if remaining == 0 {
                truncated = true;
                break;
            }

            match search_file_contents(&path, &re, remaining) {
                Ok(Some(file_result)) => {
                    total_matches += file_result.matches.len();
                    files.push(file_result);
                }
                Ok(None) => {}
                Err(_) => continue,
            }
        }

        Ok(SearchResult {
            files,
            total_matches,
            truncated,
        })
    })
    .await
    .map_err(|e| AbundioError::Search(format!("Search task failed: {}", e)))?;

    manager.cancel_flags.remove(&search_id);
    result
}

#[tauri::command]
pub async fn fs_search_cancel(
    search_id: String,
    manager: State<'_, SearchManager>,
) -> Result<(), AbundioError> {
    if let Some(flag) = manager.cancel_flags.get(&search_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn build_regex_plain_text() {
        let re = build_regex("hello", true, false, false).unwrap();
        assert!(re.is_match("hello world"));
        assert!(!re.is_match("Hello world"));
    }

    #[test]
    fn build_regex_case_insensitive() {
        let re = build_regex("hello", false, false, false).unwrap();
        assert!(re.is_match("Hello World"));
    }

    #[test]
    fn build_regex_whole_word() {
        let re = build_regex("hello", true, false, true).unwrap();
        assert!(re.is_match("say hello world"));
        assert!(!re.is_match("helloworld"));
    }

    #[test]
    fn build_regex_actual_regex() {
        let re = build_regex(r"hel+o", true, true, false).unwrap();
        assert!(re.is_match("helllo"));
        assert!(!re.is_match("heo"));
    }

    #[test]
    fn build_regex_invalid() {
        let result = build_regex("[invalid", true, true, false);
        assert!(result.is_err());
    }

    #[test]
    fn search_file_contents_finds_matches() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("test.txt");
        fs::write(&file_path, "line one\nfoo bar\nline three\nfoo baz\n").unwrap();

        let re = Regex::new("foo").unwrap();
        let result = search_file_contents(file_path.to_str().unwrap(), &re, 100).unwrap();
        let file_result = result.unwrap();
        assert_eq!(file_result.matches.len(), 2);
        assert_eq!(file_result.matches[0].line_number, 2);
        assert_eq!(file_result.matches[0].match_start, 0);
        assert_eq!(file_result.matches[0].match_end, 3);
        assert_eq!(file_result.matches[1].line_number, 4);
    }

    #[test]
    fn search_file_contents_skips_binary() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("binary.bin");
        let mut data = b"hello\x00world".to_vec();
        data.extend_from_slice(&[0u8; 100]);
        fs::write(&file_path, &data).unwrap();

        let re = Regex::new("hello").unwrap();
        let result = search_file_contents(file_path.to_str().unwrap(), &re, 100).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn search_file_contents_respects_max() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("many.txt");
        let content: String = (0..100).map(|i| format!("match line {}\n", i)).collect();
        fs::write(&file_path, &content).unwrap();

        let re = Regex::new("match").unwrap();
        let result = search_file_contents(file_path.to_str().unwrap(), &re, 5).unwrap();
        let file_result = result.unwrap();
        assert_eq!(file_result.matches.len(), 5);
    }

    #[test]
    fn search_file_contents_no_match() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("empty_match.txt");
        fs::write(&file_path, "nothing here").unwrap();

        let re = Regex::new("foobar").unwrap();
        let result = search_file_contents(file_path.to_str().unwrap(), &re, 100).unwrap();
        assert!(result.is_none());
    }
}
