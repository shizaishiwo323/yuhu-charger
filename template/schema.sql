-- 玉湖充电小助手 · 数据库表结构（Cloudflare D1 / SQLite）

-- 每台主控器一行：当前每个口的状态（JSON），只在变化时写入
CREATE TABLE IF NOT EXISTS devices (
  label TEXT PRIMARY KEY,  -- 主控器编号，如 Y1
  dev TEXT NOT NULL,       -- 设备编号（二维码链接末尾）
  raw TEXT,                -- 原始状态字符串，每个口一位
  ports TEXT,              -- JSON 数组：[{state, code, since, approx, last_end}]
  ok INTEGER DEFAULT 0,
  error TEXT,
  changed REAL             -- 最近一次状态变化时间（unix 秒）
);

-- 每一次充电一行
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  port INTEGER NOT NULL,
  start REAL NOT NULL,
  end REAL,
  approx INTEGER DEFAULT 0,  -- 1 = 监控开始前就已在充电，开始时间不可信
  start_lo REAL,             -- 真实开始 ∈ (start_lo, start]
  end_lo REAL,               -- 真实结束 ∈ (end_lo, end]
  forced INTEGER DEFAULT 0,  -- 1 = 被夜间断电强制结束（时长被截断，统计时按右删失处理）
  gap INTEGER DEFAULT 0      -- 1 = 监控断线期间开始或结束，时长不可信
);

-- 每次巡查的原始快照：raw = 各主控器状态字符串用 | 连接，查询失败记为 x
CREATE TABLE IF NOT EXISTS polls (
  ts REAL PRIMARY KEY,
  raw TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_open ON sessions(label, port, end);
CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(start);
CREATE INDEX IF NOT EXISTS idx_sessions_end ON sessions(end);

-- 杂项：最近一轮巡查时间 round、巡查租约 lease 等
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
