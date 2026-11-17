import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('storage/app.db')
const rows = db.prepare(`SELECT
  SUM(CASE WHEN COALESCE(path,'') = '' THEN 1 ELSE 0 END) empty_path,
  SUM(CASE WHEN COALESCE(path,'') = '' AND page_url IS NOT NULL THEN 1 ELSE 0 END) empty_but_url,
  SUM(CASE WHEN COALESCE(path,'') = '' AND page_url LIKE '%#%' THEN 1 ELSE 0 END) empty_url_hash,
  SUM(CASE WHEN COALESCE(path,'') = '' AND page_url IS NULL THEN 1 ELSE 0 END) empty_no_url
  FROM track_events WHERE created_at >= datetime('now','-7 days')`).get()
console.log(JSON.stringify(rows))
console.log(JSON.stringify(db.prepare(`SELECT type, count(*) n FROM track_events WHERE COALESCE(path,'')='' AND created_at >= datetime('now','-7 days') GROUP BY type ORDER BY n DESC`).all()))
