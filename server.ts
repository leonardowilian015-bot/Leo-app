import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database("expenses.db");

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL NOT NULL,
    description TEXT NOT NULL,
    category_id INTEGER,
    date TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES categories (id)
  );

  INSERT OR IGNORE INTO categories (name) VALUES ('Alimentação'), ('Transporte'), ('Lazer'), ('Saúde'), ('Educação'), ('Outros');
`);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Routes
  app.get("/api/expenses", (req, res) => {
    const expenses = db.prepare(`
      SELECT e.*, c.name as category_name 
      FROM expenses e 
      LEFT JOIN categories c ON e.category_id = c.id 
      ORDER BY date DESC
    `).all();
    res.json(expenses);
  });

  app.post("/api/expenses", (req, res) => {
    const { amount, description, category } = req.body;
    
    // Find or create category
    let cat = db.prepare("SELECT id FROM categories WHERE name = ?").get(category);
    if (!cat) {
      const info = db.prepare("INSERT INTO categories (name) VALUES (?)").run(category);
      cat = { id: info.lastInsertRowid };
    }

    const info = db.prepare("INSERT INTO expenses (amount, description, category_id) VALUES (?, ?, ?)")
      .run(amount, description, cat.id);
    
    res.json({ id: info.lastInsertRowid, status: "success" });
  });

  app.delete("/api/expenses/:id", (req, res) => {
    db.prepare("DELETE FROM expenses WHERE id = ?").run(req.params.id);
    res.json({ status: "success" });
  });

  app.get("/api/summary", (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const daily = db.prepare("SELECT SUM(amount) as total FROM expenses WHERE date >= ?").get(today);
    const byCategory = db.prepare(`
      SELECT c.name, SUM(e.amount) as total 
      FROM expenses e 
      JOIN categories c ON e.category_id = c.id 
      GROUP BY c.name
    `).all();
    res.json({ daily: daily.total || 0, byCategory });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
