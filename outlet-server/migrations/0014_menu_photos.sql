-- 0014_menu_photos.sql — dish photos. New tables only (menu_item is unchanged).

-- 1. The photos, named by the SHA-256 of their bytes ("<sha256>.webp"): stored once, a name never changes its content.
--    Kept in the database so every backup and restore carries them.
CREATE TABLE menu_image (
  name TEXT PRIMARY KEY CHECK (length(name) BETWEEN 68 AND 69),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL
);

-- 2. Which photo each dish shows (at most one).
CREATE TABLE menu_item_image (
  item_id TEXT PRIMARY KEY REFERENCES menu_item(id),
  image_name TEXT NOT NULL REFERENCES menu_image(name),
  set_at TEXT NOT NULL,
  set_by TEXT REFERENCES app_user(id)
);
CREATE INDEX idx_menu_item_image_name ON menu_item_image (image_name);
