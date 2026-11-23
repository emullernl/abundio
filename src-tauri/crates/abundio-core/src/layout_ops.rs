//! A Tab's layout edits as Rust applies them (ADR-0063,
//! docs/plans/remote-hosts.md phase 4). The Window computes each new layout
//! and diffs it into node-level ops (`lib/layoutOps.ts`); this applies them to
//! Rust's own copy. Nodes are named by id, so edits to different panes from
//! different Clients both land.
//!
//! The layout stays a `serde_json::Value`: every field a pane carries is kept,
//! including ones this file has never heard of.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// One edit (`LayoutOp` in `layoutOps.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum LayoutOp {
    /// The whole tree.
    Set { layout: Value },
    /// The subtree whose root is `id`.
    Replace { id: String, node: Value },
    /// The node `id`'s own fields.
    Patch {
        id: String,
        set: Map<String, Value>,
        unset: Vec<String>,
    },
}

/// Why a batch was not applied.
#[derive(Debug, Clone, PartialEq)]
pub enum OpError {
    /// An op names a node that is not in the tree (another Client removed it).
    Missing(String),
    /// A patch tried to change what a node is (`id`, `type`, a split's children).
    Forbidden(String),
    /// The result is not a layout.
    Invalid(String),
}

impl std::fmt::Display for OpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpError::Missing(id) => write!(f, "no pane {id} in the layout"),
            OpError::Forbidden(k) => write!(f, "a patch may not change {k}"),
            OpError::Invalid(why) => write!(f, "not a layout: {why}"),
        }
    }
}

const SIDES: [&str; 2] = ["first", "second"];

/// The first node with `id`, depth first (`first` before `second`), as
/// `paneTree.ts`'s `findNode` searches.
fn locate<'a>(tree: &'a mut Value, id: &str) -> Option<&'a mut Value> {
    if tree.get("id").and_then(Value::as_str) == Some(id) {
        return Some(tree);
    }
    if tree.get("type").and_then(Value::as_str) != Some("split") {
        return None;
    }
    // Find which side holds it first, so only one mutable borrow is taken.
    let side = SIDES
        .into_iter()
        .find(|s| tree.get(*s).is_some_and(|c| contains(c, id)))?;
    locate(tree.get_mut(side)?, id)
}

fn contains(tree: &Value, id: &str) -> bool {
    if tree.get("id").and_then(Value::as_str) == Some(id) {
        return true;
    }
    tree.get("type").and_then(Value::as_str) == Some("split")
        && SIDES
            .iter()
            .any(|s| tree.get(*s).is_some_and(|c| contains(c, id)))
}

/// Whether `v` is a pane tree: every node an object with a string `id` and
/// `type`, every split with a numeric `ratio` and two children.
pub fn validate(v: &Value) -> Result<(), OpError> {
    let obj = v
        .as_object()
        .ok_or_else(|| OpError::Invalid("a node is not an object".into()))?;
    let id = obj.get("id").and_then(Value::as_str);
    let kind = obj.get("type").and_then(Value::as_str);
    let (Some(_), Some(kind)) = (id, kind) else {
        return Err(OpError::Invalid("a node has no id or type".into()));
    };
    if kind == "split" {
        if !obj.get("ratio").is_some_and(Value::is_number) {
            return Err(OpError::Invalid("a split has no ratio".into()));
        }
        for s in SIDES {
            validate(
                obj.get(s)
                    .ok_or_else(|| OpError::Invalid(format!("a split has no {s}")))?,
            )?;
        }
    }
    Ok(())
}

/// `tree` with `ops` applied, all or nothing.
pub fn apply(tree: &Value, ops: &[LayoutOp]) -> Result<Value, OpError> {
    let mut root = tree.clone();
    for op in ops {
        match op {
            LayoutOp::Set { layout } => root = layout.clone(),
            LayoutOp::Replace { id, node } => {
                let at = locate(&mut root, id).ok_or_else(|| OpError::Missing(id.clone()))?;
                *at = node.clone();
            }
            LayoutOp::Patch { id, set, unset } => {
                let at = locate(&mut root, id).ok_or_else(|| OpError::Missing(id.clone()))?;
                let is_split = at.get("type").and_then(Value::as_str) == Some("split");
                for k in set.keys().chain(unset.iter()) {
                    if k == "id" || k == "type" || (is_split && SIDES.contains(&k.as_str())) {
                        return Err(OpError::Forbidden(k.clone()));
                    }
                }
                let obj = at
                    .as_object_mut()
                    .ok_or_else(|| OpError::Invalid("a node is not an object".into()))?;
                for k in unset {
                    obj.remove(k);
                }
                for (k, v) in set {
                    obj.insert(k.clone(), v.clone());
                }
            }
        }
    }
    validate(&root)?;
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(Deserialize)]
    struct Case {
        base: Value,
        next: Value,
        ops: Vec<LayoutOp>,
    }

    #[derive(Deserialize)]
    struct Fixture {
        cases: Vec<Case>,
    }

    #[test]
    fn replays_every_case_the_window_diffed() {
        let raw = include_str!("../../../../src/lib/__tests__/fixtures/layoutOps.json");
        let fixture: Fixture = serde_json::from_str(raw).unwrap();
        assert!(fixture.cases.len() >= 300);
        for (i, c) in fixture.cases.iter().enumerate() {
            let got = apply(&c.base, &c.ops).unwrap_or_else(|e| panic!("case {i}: {e}"));
            assert_eq!(got, c.next, "case {i}");
        }
    }

    fn two() -> Value {
        json!({
            "type": "split", "id": "s", "direction": "vertical", "ratio": 0.5,
            "first": { "type": "terminal", "id": "a", "ptyId": "" },
            "second": { "type": "terminal", "id": "b", "ptyId": "" }
        })
    }

    #[test]
    fn edits_to_different_panes_both_land() {
        let mine = vec![LayoutOp::Patch {
            id: "a".into(),
            set: json!({ "cwd": "/x" }).as_object().unwrap().clone(),
            unset: vec![],
        }];
        let theirs = vec![LayoutOp::Replace {
            id: "b".into(),
            node: json!({
                "type": "split", "id": "s2", "direction": "horizontal", "ratio": 0.5,
                "first": { "type": "terminal", "id": "b", "ptyId": "" },
                "second": { "type": "terminal", "id": "c", "ptyId": "" }
            }),
        }];
        let after = apply(&apply(&two(), &theirs).unwrap(), &mine).unwrap();
        assert_eq!(after["first"]["cwd"], "/x");
        assert_eq!(after["second"]["second"]["id"], "c");
    }

    #[test]
    fn a_batch_naming_a_gone_pane_applies_nothing() {
        let ops = vec![
            LayoutOp::Patch {
                id: "a".into(),
                set: json!({ "cwd": "/x" }).as_object().unwrap().clone(),
                unset: vec![],
            },
            LayoutOp::Patch { id: "zz".into(), set: Map::new(), unset: vec!["cwd".into()] },
        ];
        assert_eq!(apply(&two(), &ops), Err(OpError::Missing("zz".into())));
    }

    #[test]
    fn a_patch_cannot_change_what_a_node_is() {
        for k in ["id", "type", "first"] {
            let ops = vec![LayoutOp::Patch {
                id: "s".into(),
                set: json!({ k: "x" }).as_object().unwrap().clone(),
                unset: vec![],
            }];
            assert_eq!(apply(&two(), &ops), Err(OpError::Forbidden(k.into())));
        }
    }

    #[test]
    fn refuses_a_result_that_is_not_a_layout() {
        let ops = vec![LayoutOp::Replace { id: "a".into(), node: json!({ "type": "terminal" }) }];
        assert!(matches!(apply(&two(), &ops), Err(OpError::Invalid(_))));
        let ops = vec![LayoutOp::Patch {
            id: "s".into(),
            set: Map::new(),
            unset: vec!["ratio".into()],
        }];
        assert!(matches!(apply(&two(), &ops), Err(OpError::Invalid(_))));
    }

    #[test]
    fn keeps_fields_it_does_not_know() {
        let mut t = two();
        t["first"]["somethingNew"] = json!({ "deep": [1, 2] });
        let ops = vec![LayoutOp::Patch {
            id: "a".into(),
            set: json!({ "cwd": "/x" }).as_object().unwrap().clone(),
            unset: vec![],
        }];
        assert_eq!(apply(&t, &ops).unwrap()["first"]["somethingNew"]["deep"][1], 2);
    }
}
