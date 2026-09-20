//! **Prompt actions**: named, parameterised prompts a user fires at a running
//! **Agent** with one click, from the **Action bar** at the bottom of a Pane.
//!
//! See the `Prompt action`, `Action bar`, `Action scope`, `Firing` and
//! `Prompt action store` entries in CONTEXT.md, ADR-0038 (attachments travel by
//! path) and ADR-0039 (this lives in SQLite, not `settingsStore`).
//!
//! ## Why this is a table and not a setting
//!
//! Every other app-global setting lives in `settingsStore` and persists to
//! `localStorage`. Prompt actions do not, because the in-pane authoring popover
//! makes writes *frequent* and *multi-window*, and `localStorage` is isolated
//! per Tauri webview — cross-window sync ships the whole array in a broadcast
//! payload, so two Windows appending lose one append silently.
//!
//! A JSON blob in the key-value `settings` table has the same bug by a
//! different route: SQLite serialises the write but not the read before it. One
//! row per action is what actually fixes it, because two INSERTs do not
//! conflict. See ADR-0039.
//!
//! ## What this module does not own
//!
//! Parameter *names* are derived in the frontend from the body's `{{…}}`
//! placeholders (`src/lib/promptActions.ts`) and are never stored. `params_json`
//! carries only their metadata, so an entry whose placeholder has since been
//! deleted is inert rather than a conflict. Resolution, control-character
//! stripping and the `canFire` guard are all frontend concerns — nothing here
//! ever composes a prompt.

use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};
use uuid::Uuid;

use crate::error::AbundioError;

/// Broadcast when the list changes, so every Window re-reads.
///
/// Deliberately payload-free. Shipping the list would reintroduce exactly the
/// clobbering this storage choice exists to avoid, and a receiver that misses
/// an event self-corrects on its next read instead of persisting a stale
/// snapshot. See ADR-0039.
pub const PROMPT_ACTIONS_CHANGED: &str = "prompt-actions-changed";

/// Longest accepted action name. Long names truncate in the bar anyway; this is
/// about refusing something pathological, not about layout.
const MAX_NAME_LEN: usize = 200;

/// Longest accepted body. Far above any real prompt, far below a size that
/// would make the bracketed paste itself a problem.
const MAX_BODY_LEN: usize = 100_000;

// ── Types ──

/// Which **Agents** an action is offered for.
///
/// `All` and a `Set` naming every current Agent are deliberately different
/// values, not one expressed as the other: `All` must pick up an Agent the user
/// adds tomorrow, an explicit set must not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScopeKind {
    All,
    Set,
}

impl ScopeKind {
    fn as_str(&self) -> &'static str {
        match self {
            ScopeKind::All => "all",
            ScopeKind::Set => "set",
        }
    }

    /// Unknown values read as `All` rather than failing the whole list. A row
    /// written by a newer build should leave the user with a usable bar, not an
    /// error page.
    fn from_str(s: &str) -> Self {
        match s {
            "set" => ScopeKind::Set,
            _ => ScopeKind::All,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptAction {
    pub id: String,
    pub name: String,
    pub body: String,
    pub scope_kind: ScopeKind,
    /// Meaningful only when `scope_kind` is `Set`. May legitimately be empty —
    /// an action whose only Agent was deleted is kept and simply never
    /// rendered, because deleting it is the user's call, not ours.
    pub scope_agent_ids: Vec<String>,
    /// Parameter metadata keyed by name, opaque here. Type, default, and a
    /// toggle's on/off text. The frontend owns its shape.
    pub params_json: String,
    pub show_in_bar: bool,
    pub position: i32,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A create request. Everything but the body has a sensible default, so the
/// in-pane popover can post a name and a body and nothing else.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptActionCreate {
    pub name: String,
    pub body: String,
    #[serde(default)]
    pub scope_kind: Option<ScopeKind>,
    #[serde(default)]
    pub scope_agent_ids: Option<Vec<String>>,
    #[serde(default)]
    pub params_json: Option<String>,
    #[serde(default)]
    pub show_in_bar: Option<bool>,
}

/// A partial update. `None` means "leave alone" — this is how the popover can
/// edit a name without having to round-trip the whole row it never loaded.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptActionUpdate {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub scope_kind: Option<ScopeKind>,
    #[serde(default)]
    pub scope_agent_ids: Option<Vec<String>>,
    #[serde(default)]
    pub params_json: Option<String>,
    #[serde(default)]
    pub show_in_bar: Option<bool>,
}

// ── Validation ──

/// Rejects names and bodies that should never have been sent.
///
/// Validated **here**, not only in the UI, for the same reason
/// `env_crypto::validate_name` is: there are two authoring surfaces (the
/// popover and the Settings editor) and the IPC is downstream of both, so a UI
/// that forgets a check must not be able to write a row nothing can render.
fn validate(name: &str, body: &str) -> Result<(), AbundioError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AbundioError::InvalidOperation(
            "A prompt action needs a name".into(),
        ));
    }
    if trimmed.chars().count() > MAX_NAME_LEN {
        return Err(AbundioError::InvalidOperation(format!(
            "Name is longer than {MAX_NAME_LEN} characters"
        )));
    }
    // An **empty body is allowed**, and deliberately so: Settings creates a row
    // first and lets the user fill it in, so a half-authored action is a normal
    // intermediate state rather than an error. What must never happen is such an
    // action reaching a bar or firing — that is enforced where actions are
    // *offered* (`actionsForPane` skips them), the same way an action whose
    // scope set has emptied out is kept but never rendered.
    if body.len() > MAX_BODY_LEN {
        return Err(AbundioError::InvalidOperation(format!(
            "Body is longer than {MAX_BODY_LEN} bytes"
        )));
    }
    Ok(())
}

/// Guards against a malformed `params_json` reaching the database.
///
/// The frontend owns the *shape* of this object, so this checks only that it is
/// a JSON object at all. A row whose params fail to parse would render a dialog
/// with no fields, and the action would fire with unresolved `{{…}}` still in
/// the body — sent to a live Agent, since firing submits.
fn validate_params_json(raw: &str) -> Result<(), AbundioError> {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::Object(_)) => Ok(()),
        Ok(_) => Err(AbundioError::InvalidOperation(
            "Parameter metadata must be a JSON object".into(),
        )),
        Err(e) => Err(AbundioError::InvalidOperation(format!(
            "Parameter metadata is not valid JSON: {e}"
        ))),
    }
}

// ── Store ──

pub struct PromptActionStore {
    conn: Mutex<Connection>,
}

impl PromptActionStore {
    pub fn new(conn: Connection) -> Self {
        Self {
            conn: Mutex::new(conn),
        }
    }

    /// Every action, in authored order. The frontend does the scope filtering,
    /// because only it knows which Agent a given Pane resolved to.
    pub fn list(&self) -> Result<Vec<PromptAction>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, body, scope_kind, scope_agent_ids, params_json,
                    show_in_bar, position, created_at, updated_at
             FROM prompt_actions
             ORDER BY position ASC, created_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            let scope_raw: String = row.get(4)?;
            Ok(PromptAction {
                id: row.get(0)?,
                name: row.get(1)?,
                body: row.get(2)?,
                scope_kind: ScopeKind::from_str(&row.get::<_, String>(3)?),
                // A corrupt array degrades to "no agents selected", which
                // renders as an action that is kept but never offered. Better
                // than failing the whole list over one bad row.
                scope_agent_ids: serde_json::from_str(&scope_raw).unwrap_or_default(),
                params_json: row.get(5)?,
                show_in_bar: row.get::<_, i32>(6)? != 0,
                position: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn create(&self, req: PromptActionCreate) -> Result<PromptAction, AbundioError> {
        validate(&req.name, &req.body)?;
        let params_json = req.params_json.unwrap_or_else(|| "{}".into());
        validate_params_json(&params_json)?;

        let scope_kind = req.scope_kind.unwrap_or(ScopeKind::All);
        let scope_agent_ids = req.scope_agent_ids.unwrap_or_default();
        let show_in_bar = req.show_in_bar.unwrap_or(true);

        let conn = self.conn.lock().unwrap();
        // Append to the end. Read-then-write is safe here in a way the array
        // rewrite was not: a lost race costs two actions the same position,
        // which sorts stably by created_at and is fixed by a reorder — it does
        // not lose an action.
        let next_pos: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(position) + 1, 0) FROM prompt_actions",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);

        let action = PromptAction {
            id: Uuid::new_v4().to_string(),
            name: req.name.trim().to_string(),
            body: req.body,
            scope_kind,
            scope_agent_ids,
            params_json,
            show_in_bar,
            position: next_pos,
            created_at: now(),
            updated_at: now(),
        };

        conn.execute(
            "INSERT INTO prompt_actions
               (id, name, body, scope_kind, scope_agent_ids, params_json,
                show_in_bar, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                action.id,
                action.name,
                action.body,
                action.scope_kind.as_str(),
                serde_json::to_string(&action.scope_agent_ids).unwrap_or_else(|_| "[]".into()),
                action.params_json,
                action.show_in_bar as i32,
                action.position,
                action.created_at,
                action.updated_at,
            ],
        )?;
        Ok(action)
    }

    pub fn update(&self, id: &str, u: PromptActionUpdate) -> Result<PromptAction, AbundioError> {
        // Validate against the *merged* result, not the patch: a patch that
        // only clears the body must still be rejected, and a patch that only
        // renames must not be asked for a body it never carried.
        let current = self
            .get(id)?
            .ok_or_else(|| AbundioError::NotFound(format!("prompt action {id}")))?;
        let name = u.name.clone().unwrap_or_else(|| current.name.clone());
        let body = u.body.clone().unwrap_or_else(|| current.body.clone());
        validate(&name, &body)?;
        if let Some(ref p) = u.params_json {
            validate_params_json(p)?;
        }

        let conn = self.conn.lock().unwrap();
        let mut sets: Vec<String> = Vec::new();
        let mut vals: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if u.name.is_some() {
            sets.push(format!("name = ?{}", vals.len() + 1));
            vals.push(Box::new(name.trim().to_string()));
        }
        if u.body.is_some() {
            sets.push(format!("body = ?{}", vals.len() + 1));
            vals.push(Box::new(body));
        }
        if let Some(ref k) = u.scope_kind {
            sets.push(format!("scope_kind = ?{}", vals.len() + 1));
            vals.push(Box::new(k.as_str().to_string()));
        }
        if let Some(ref ids) = u.scope_agent_ids {
            sets.push(format!("scope_agent_ids = ?{}", vals.len() + 1));
            vals.push(Box::new(
                serde_json::to_string(ids).unwrap_or_else(|_| "[]".into()),
            ));
        }
        if let Some(ref p) = u.params_json {
            sets.push(format!("params_json = ?{}", vals.len() + 1));
            vals.push(Box::new(p.clone()));
        }
        if let Some(s) = u.show_in_bar {
            sets.push(format!("show_in_bar = ?{}", vals.len() + 1));
            vals.push(Box::new(s as i32));
        }

        if !sets.is_empty() {
            sets.push(format!("updated_at = ?{}", vals.len() + 1));
            vals.push(Box::new(now()));
            vals.push(Box::new(id.to_string()));
            let sql = format!(
                "UPDATE prompt_actions SET {} WHERE id = ?{}",
                sets.join(", "),
                vals.len()
            );
            let refs: Vec<&dyn rusqlite::ToSql> = vals.iter().map(|b| b.as_ref()).collect();
            conn.execute(&sql, refs.as_slice())?;
        }
        drop(conn);

        self.get(id)?
            .ok_or_else(|| AbundioError::NotFound(format!("prompt action {id}")))
    }

    pub fn delete(&self, id: &str) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM prompt_actions WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Rewrites positions to match `ids`.
    ///
    /// Order is load-bearing in a way it usually is not: the **position
    /// number** on a bar button is what `Cmd+<digit>` fires, so a reorder moves
    /// keyboard shortcuts. Ids not listed keep their row untouched.
    pub fn reorder(&self, ids: &[String]) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE prompt_actions SET position = ?1 WHERE id = ?2",
                params![i as i32, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    fn get(&self, id: &str) -> Result<Option<PromptAction>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let row = conn
            .query_row(
                "SELECT id, name, body, scope_kind, scope_agent_ids, params_json,
                        show_in_bar, position, created_at, updated_at
                 FROM prompt_actions WHERE id = ?1",
                params![id],
                |row| {
                    let scope_raw: String = row.get(4)?;
                    Ok(PromptAction {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        body: row.get(2)?,
                        scope_kind: ScopeKind::from_str(&row.get::<_, String>(3)?),
                        scope_agent_ids: serde_json::from_str(&scope_raw).unwrap_or_default(),
                        params_json: row.get(5)?,
                        show_in_bar: row.get::<_, i32>(6)? != 0,
                        position: row.get(7)?,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ── IPC ──

/// Tells every Window the list moved. Payload-free by design (ADR-0039).
fn broadcast(app: &tauri::AppHandle) {
    if let Err(e) = app.emit(PROMPT_ACTIONS_CHANGED, ()) {
        log::warn!("[prompt-actions] could not broadcast change: {e}");
    }
}

#[tauri::command]
pub fn prompt_actions_list(
    store: State<'_, PromptActionStore>,
) -> Result<Vec<PromptAction>, AbundioError> {
    store.list()
}

#[tauri::command]
pub fn prompt_action_create(
    app: tauri::AppHandle,
    store: State<'_, PromptActionStore>,
    action: PromptActionCreate,
) -> Result<PromptAction, AbundioError> {
    let created = store.create(action)?;
    broadcast(&app);
    Ok(created)
}

#[tauri::command]
pub fn prompt_action_update(
    app: tauri::AppHandle,
    store: State<'_, PromptActionStore>,
    id: String,
    updates: PromptActionUpdate,
) -> Result<PromptAction, AbundioError> {
    let updated = store.update(&id, updates)?;
    broadcast(&app);
    Ok(updated)
}

#[tauri::command]
pub fn prompt_action_delete(
    app: tauri::AppHandle,
    store: State<'_, PromptActionStore>,
    id: String,
) -> Result<(), AbundioError> {
    store.delete(&id)?;
    broadcast(&app);
    Ok(())
}

#[tauri::command]
pub fn prompt_actions_reorder(
    app: tauri::AppHandle,
    store: State<'_, PromptActionStore>,
    ids: Vec<String>,
) -> Result<(), AbundioError> {
    store.reorder(&ids)?;
    broadcast(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> PromptActionStore {
        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::run_migrations(&conn).unwrap();
        PromptActionStore::new(conn)
    }

    fn new_action(name: &str) -> PromptActionCreate {
        PromptActionCreate {
            name: name.into(),
            body: "/review".into(),
            scope_kind: None,
            scope_agent_ids: None,
            params_json: None,
            show_in_bar: None,
        }
    }

    #[test]
    fn create_defaults_to_all_agents_shown_in_bar() {
        let s = store();
        let a = s.create(new_action("Review")).unwrap();
        assert_eq!(a.scope_kind, ScopeKind::All);
        assert!(a.scope_agent_ids.is_empty());
        assert!(a.show_in_bar);
        assert_eq!(a.params_json, "{}");
    }

    #[test]
    fn create_appends_to_the_end() {
        let s = store();
        let first = s.create(new_action("First")).unwrap();
        let second = s.create(new_action("Second")).unwrap();
        assert!(second.position > first.position);
        let names: Vec<String> = s.list().unwrap().into_iter().map(|a| a.name).collect();
        assert_eq!(names, vec!["First", "Second"]);
    }

    #[test]
    fn name_is_trimmed_and_blank_is_refused() {
        let s = store();
        let a = s.create(new_action("  Review  ")).unwrap();
        assert_eq!(a.name, "Review");

        let mut blank = new_action("   ");
        blank.body = "/x".into();
        assert!(s.create(blank).is_err());
    }

    #[test]
    fn a_blank_body_is_allowed_as_a_draft() {
        // Settings creates the row, then the user fills it in. Refusing this
        // made every "Add action" button in Settings fail silently. Keeping such
        // an action out of a bar is the frontend's job, at the point of offer.
        let s = store();
        let mut a = new_action("Draft");
        a.body = "".into();
        let created = s.create(a).unwrap();
        assert_eq!(created.body, "");

        // And it can still be emptied by an edit.
        let updated = s
            .update(
                &created.id,
                PromptActionUpdate {
                    body: Some("   ".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.body, "   ");
    }

    #[test]
    fn malformed_params_json_is_refused() {
        // A row whose params cannot parse renders a dialog with no fields, and
        // the action then fires with unresolved `{{…}}` at a live Agent.
        let s = store();
        let mut a = new_action("Bad");
        a.params_json = Some("not json".into());
        assert!(s.create(a).is_err());

        let mut b = new_action("AlsoBad");
        b.params_json = Some("[1,2,3]".into());
        assert!(s.create(b).is_err());
    }

    #[test]
    fn scope_set_round_trips() {
        let s = store();
        let mut a = new_action("Claude only");
        a.scope_kind = Some(ScopeKind::Set);
        a.scope_agent_ids = Some(vec!["claude-code".into(), "codex".into()]);
        let created = s.create(a).unwrap();

        let read = s.list().unwrap().into_iter().next().unwrap();
        assert_eq!(read.id, created.id);
        assert_eq!(read.scope_kind, ScopeKind::Set);
        assert_eq!(read.scope_agent_ids, vec!["claude-code", "codex"]);
    }

    #[test]
    fn an_empty_scope_set_is_kept_not_rejected() {
        // The action's only Agent was deleted. Keeping it is deliberate:
        // deleting is the user's call, and the frontend simply never renders it.
        let s = store();
        let mut a = new_action("Orphaned");
        a.scope_kind = Some(ScopeKind::Set);
        a.scope_agent_ids = Some(vec![]);
        let created = s.create(a).unwrap();
        assert_eq!(created.scope_kind, ScopeKind::Set);
        assert!(created.scope_agent_ids.is_empty());
        assert_eq!(s.list().unwrap().len(), 1);
    }

    #[test]
    fn update_is_partial_and_leaves_the_rest_alone() {
        let s = store();
        let a = s.create(new_action("Before")).unwrap();
        let updated = s
            .update(
                &a.id,
                PromptActionUpdate {
                    name: Some("After".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.name, "After");
        assert_eq!(updated.body, a.body);
        assert_eq!(updated.show_in_bar, a.show_in_bar);
    }

    #[test]
    fn update_validates_the_merged_row_not_the_patch() {
        // Clearing only the *name* must be refused even though the patch says
        // nothing about the body.
        let s = store();
        let a = s.create(new_action("Review")).unwrap();
        let res = s.update(
            &a.id,
            PromptActionUpdate {
                name: Some("   ".into()),
                ..Default::default()
            },
        );
        assert!(res.is_err());
        // And a rename alone is fine, though it carries no body.
        assert!(s
            .update(
                &a.id,
                PromptActionUpdate {
                    name: Some("Renamed".into()),
                    ..Default::default()
                },
            )
            .is_ok());
    }

    #[test]
    fn update_can_turn_off_show_in_bar() {
        let s = store();
        let a = s.create(new_action("Hidden")).unwrap();
        let updated = s
            .update(
                &a.id,
                PromptActionUpdate {
                    show_in_bar: Some(false),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(!updated.show_in_bar);
    }

    #[test]
    fn update_of_a_missing_id_is_not_found() {
        let s = store();
        let res = s.update("nope", PromptActionUpdate::default());
        assert!(matches!(res, Err(AbundioError::NotFound(_))));
    }

    #[test]
    fn reorder_rewrites_positions() {
        let s = store();
        let a = s.create(new_action("A")).unwrap();
        let b = s.create(new_action("B")).unwrap();
        let c = s.create(new_action("C")).unwrap();

        s.reorder(&[c.id.clone(), a.id.clone(), b.id.clone()])
            .unwrap();

        let names: Vec<String> = s.list().unwrap().into_iter().map(|x| x.name).collect();
        assert_eq!(names, vec!["C", "A", "B"]);
    }

    #[test]
    fn delete_removes_only_its_own_row() {
        let s = store();
        let a = s.create(new_action("Keep")).unwrap();
        let b = s.create(new_action("Drop")).unwrap();
        s.delete(&b.id).unwrap();
        let remaining = s.list().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, a.id);
    }

    #[test]
    fn delete_of_a_missing_id_is_not_an_error() {
        // Two Windows can delete the same action; the second must not fail.
        let s = store();
        assert!(s.delete("never-existed").is_ok());
    }

    #[test]
    fn unknown_scope_kind_reads_as_all() {
        // A row written by a newer build should leave a usable bar, not an
        // error page.
        assert_eq!(ScopeKind::from_str("something-new"), ScopeKind::All);
        assert_eq!(ScopeKind::from_str("set"), ScopeKind::Set);
    }

    #[test]
    fn a_corrupt_scope_array_degrades_to_empty() {
        let s = store();
        let a = s.create(new_action("Corrupt")).unwrap();
        {
            let conn = s.conn.lock().unwrap();
            conn.execute(
                "UPDATE prompt_actions SET scope_agent_ids = 'not json' WHERE id = ?1",
                params![a.id],
            )
            .unwrap();
        }
        let read = s.list().unwrap();
        assert_eq!(read.len(), 1, "one bad row must not fail the whole list");
        assert!(read[0].scope_agent_ids.is_empty());
    }

    #[test]
    fn an_overlong_name_is_refused() {
        let s = store();
        let mut a = new_action("x");
        a.name = "n".repeat(MAX_NAME_LEN + 1);
        assert!(s.create(a).is_err());
    }
}
