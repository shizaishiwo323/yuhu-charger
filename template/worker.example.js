// 玉湖充电小助手 · Worker 骨架（Cloudflare Workers + D1）
//
// 这是去掉了平台接口细节的简化版本，演示“定时巡查 → 对比上一次 → 生成充电记录 → 给页面提供 API”的整体结构。
// 标了 TODO 的地方需要你按自己抓包的结果填写（见 docs/复刻指南.md）。

// TODO：你抓到的“查询单台设备插座状态”的请求地址
const STATUS_API = "<填写你自己抓到的设备状态接口>";

// 主控器编号 -> 设备编号（来自主控器上的二维码链接末尾）
const DEVICES = [
  ["Y1", "<设备编号>"],
  ["Y2", "<设备编号>"],
  // ...
];

// TODO：状态码 -> 状态。对照平台“选择插座”页面上每个口的颜色/文字自己推断
const STATE_MAP = {
  // "?": "free",
  // "?": "charging",
  // "?": "float",
};
const stateOf = (ch) => STATE_MAP[ch] ?? "fault";
const isActive = (s) => s === "charging" || s === "float"; // 浮充也算同一次充电

const POLL_SEC = 60;
const LEASE_SEC = 50;

// 查一台主控器，返回每个口一位状态码的字符串
async function fetchDevice(dev) {
  // TODO：按抓包结果构造请求（方法、请求头、参数），并从返回里取出插座状态
  const res = await fetch(STATUS_API, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ /* 设备编号等参数 */ dev }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return String(data /* TODO：取出状态字符串 */);
}

// 对比上一次和这一次：空闲 -> 占用 = 开始一次充电；占用 -> 空闲 = 结束
// lo = 上一次成功查询的时间。每分钟才看一次，所以真实开始/结束时间落在 (lo, now] 区间里
function diffPorts(label, prevPorts, raw, now, lo, stmts, db) {
  const next = [];
  for (let i = 0; i < raw.length; i++) {
    const port = i + 1;
    const code = raw[i];
    const state = stateOf(code);
    const prev = prevPorts?.[i] ?? null;
    let rec;
    if (isActive(state)) {
      if (prev && isActive(prev.state)) {
        rec = { ...prev, state, code }; // 还在充（充电中 <-> 浮充 不算新的一次）
      } else {
        const approx = prev ? 0 : 1; // 第一次见到就已经在充：开始时间不可信
        rec = { state, code, since: now, approx, last_end: prev?.last_end ?? null };
        stmts.push(
          db.prepare("INSERT INTO sessions(label, port, start, start_lo, end, approx) VALUES (?,?,?,?,NULL,?)")
            .bind(label, port, now, approx ? null : lo, approx)
        );
      }
    } else if (prev && isActive(prev.state)) {
      rec = { state, code, since: now, approx: 0, last_end: now };
      stmts.push(
        db.prepare("UPDATE sessions SET end=?, end_lo=? WHERE label=? AND port=? AND end IS NULL")
          .bind(now, lo, label, port)
      );
    } else {
      rec = prev && prev.state === state ? { ...prev, code } : { state, code, since: now, approx: prev ? 0 : 1 };
    }
    next.push(rec);
  }
  return next;
}

async function pollAll(env) {
  const now = Date.now() / 1000;
  const db = env.DB;
  const [devRows, lastPoll] = await db.batch([
    db.prepare("SELECT * FROM devices"),
    db.prepare("SELECT ts FROM polls ORDER BY ts DESC LIMIT 1"),
  ]);
  const prevByLabel = Object.fromEntries(devRows.results.map((r) => [r.label, r]));
  const lo = lastPoll.results[0]?.ts ?? null;
  // 几台主控器并行查询
  const fetched = await Promise.allSettled(DEVICES.map(([, dev]) => fetchDevice(dev)));

  const stmts = [];
  const snap = [];
  DEVICES.forEach(([label, dev], idx) => {
    const r = fetched[idx];
    const prev = prevByLabel[label];
    if (r.status !== "fulfilled") {
      snap.push("x");
      stmts.push(
        db.prepare("INSERT INTO devices(label, dev, ok, error) VALUES (?,?,0,?) ON CONFLICT(label) DO UPDATE SET ok=0, error=excluded.error")
          .bind(label, dev, String(r.reason?.message || r.reason).slice(0, 200))
      );
      return;
    }
    const raw = r.value;
    snap.push(raw);
    if (prev && prev.ok && prev.raw === raw) return; // 没变化就不写库，节省免费额度
    const ports = diffPorts(label, prev?.ports ? JSON.parse(prev.ports) : null, raw, now, lo, stmts, db);
    stmts.push(
      db.prepare(
        `INSERT INTO devices(label, dev, raw, ports, ok, error, changed) VALUES (?,?,?,?,1,NULL,?)
         ON CONFLICT(label) DO UPDATE SET raw=excluded.raw, ports=excluded.ports, ok=1, error=NULL, changed=excluded.changed`
      ).bind(label, dev, raw, JSON.stringify(ports), now)
    );
  });
  // 每分钟一行原始快照，留着以后做统计和预测
  stmts.push(db.prepare("INSERT OR REPLACE INTO polls(ts, raw) VALUES (?, ?)").bind(now, snap.join("|")));
  stmts.push(db.prepare("INSERT INTO meta(k, v) VALUES ('round', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(String(now)));
  await db.batch(stmts);
}

// 租约：定时任务和“页面访问时发现数据过期顺手巡查”共用，避免同一分钟重复查询
async function withLease(env, fn) {
  const now = Date.now() / 1000;
  const got = await env.DB.prepare(
    "INSERT INTO meta(k, v) VALUES ('lease', ?1) ON CONFLICT(k) DO UPDATE SET v=?1 WHERE CAST(meta.v AS REAL) < ?2"
  ).bind(String(now + LEASE_SEC), now).run();
  if (got.meta.changes) await fn();
}

async function buildStatus(env) {
  const [devs, round] = await env.DB.batch([
    env.DB.prepare("SELECT label, raw, ports, ok, error, changed FROM devices ORDER BY label"),
    env.DB.prepare("SELECT v FROM meta WHERE k='round'"),
  ]);
  return {
    updated: Number(round.results[0]?.v) || null,
    devices: devs.results.map((d) => ({ ...d, ports: d.ports ? JSON.parse(d.ports) : [] })),
  };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(withLease(env, () => pollAll(env)));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/status") {
      const status = await buildStatus(env);
      // 数据过期（比如定时任务没跑）时，顺手巡查一次
      if (!status.updated || Date.now() / 1000 - status.updated > POLL_SEC * 2) {
        ctx.waitUntil(withLease(env, () => pollAll(env)));
      }
      return Response.json(status, { headers: { "Cache-Control": "no-store" } });
    }
    return env.ASSETS.fetch(request); // 其余请求交给静态页面
  },
};
