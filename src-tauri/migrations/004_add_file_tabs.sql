ALTER TABLE sessions ADD COLUMN file_tabs_json TEXT NOT NULL DEFAULT '{"tabs":[],"activeFileTabId":null,"activeView":"terminal"}';
