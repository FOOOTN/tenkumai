// 天空米：富山商会・運営者用の管理ページ（kanri.html）から呼ぶ
// Supabase Edge Function「tenkumai-admin」（JWT 確認オフ。代わりに「管理用の合言葉」で確かめる）
// Secrets：TENKU_SELLER_KEY（富山商会用の合言葉）・TENKU_OPERATOR_KEY（照櫟VorDX用の合言葉）
//   ※試作用のしくみ。天空米を専用プロジェクトに移すときに、Supabase のログイン（メール）に切り替える
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-tenkumai-key", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function same(a: string, b: string) {   // 長さや内容で時間差が出ない比較
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y); let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}
async function roleOf(k: string) {
  const op = Deno.env.get("TENKU_OPERATOR_KEY") || "", se = Deno.env.get("TENKU_SELLER_KEY") || "";
  if (!k || k.length < 8) return null;
  if (op.length >= 8 && await same(k, op)) return "operator";
  if (se.length >= 8 && await same(k, se)) return "seller";
  return null;
}
const must = (e: { message: string } | null) => { if (e) throw new Error(e.message); };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const role = await roleOf(req.headers.get("x-tenkumai-key") || "");
    if (!role) { await new Promise((r) => setTimeout(r, 800)); return json({ error: "合言葉が違います" }, 401); }
    const b = await req.json().catch(() => ({}));
    const a = b.action;

    if (a === "me") return json({ role });

    if (a === "orders") {
      let q = db.from("tenkumai_orders").select("*").order("created_at", { ascending: false }).limit(300);
      if (b.status) q = q.eq("status", b.status);
      if (b.month) { const [y, m] = String(b.month).split("-").map(Number); q = q.gte("created_at", new Date(Date.UTC(y, m - 1, 1) - 9 * 3600e3).toISOString()).lt("created_at", new Date(Date.UTC(y, m, 1) - 9 * 3600e3).toISOString()); }
      const { data, error } = await q; must(error); return json({ orders: data });
    }
    if (a === "order_update") {
      const st = String(b.status || "");
      if (!["received", "paid", "shipped", "canceled"].includes(st)) return json({ error: "状態が正しくありません" }, 400);
      const patch: Record<string, unknown> = { status: st, tracking: b.tracking ? String(b.tracking).slice(0, 80) : null };
      if (st === "shipped") patch.shipped_at = new Date().toISOString();
      if (st === "paid") patch.paid_at = new Date().toISOString();
      const { data, error } = await db.from("tenkumai_orders").update(patch).eq("order_no", String(b.order_no)).select().single(); must(error);
      return json({ order: data });
    }

    if (a === "products") { const { data, error } = await db.from("tenkumai_products").select("*").order("sort"); must(error); return json({ products: data }); }
    if (a === "product_update") {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (b.price !== undefined) { const p = Math.floor(Number(b.price)); if (!(p >= 1 && p <= 1000000)) return json({ error: "価格が正しくありません" }, 400); patch.price = p; }
      for (const k of ["sold_out", "active", "tentative"]) if (b[k] !== undefined) patch[k] = !!b[k];
      const { data, error } = await db.from("tenkumai_products").update(patch).eq("sku", String(b.sku)).select().single(); must(error);
      return json({ product: data });
    }

    if (a === "news") { const { data, error } = await db.from("tenkumai_news").select("*").order("created_at", { ascending: false }); must(error); return json({ news: data }); }
    if (a === "news_add") { const t = String(b.body || "").trim().slice(0, 300); if (!t) return json({ error: "本文を入力してください" }, 400);
      const { data, error } = await db.from("tenkumai_news").insert({ body: t }).select().single(); must(error); return json({ item: data }); }
    if (a === "news_update") { const patch: Record<string, unknown> = {}; if (b.body !== undefined) patch.body = String(b.body).slice(0, 300); if (b.published !== undefined) patch.published = !!b.published;
      const { data, error } = await db.from("tenkumai_news").update(patch).eq("id", Number(b.id)).select().single(); must(error); return json({ item: data }); }
    if (a === "news_delete") { const { error } = await db.from("tenkumai_news").delete().eq("id", Number(b.id)); must(error); return json({ ok: true }); }

    if (a === "contacts") { const { data, error } = await db.from("tenkumai_contacts").select("*").order("created_at", { ascending: false }).limit(200); must(error); return json({ contacts: data }); }
    if (a === "contact_update") {
      const patch: Record<string, unknown> = {};
      if (b.status !== undefined) { if (!["new", "done"].includes(String(b.status))) return json({ error: "状態が正しくありません" }, 400); patch.status = b.status; }
      if (b.memo !== undefined) patch.memo = String(b.memo).slice(0, 500);
      const { data, error } = await db.from("tenkumai_contacts").update(patch).eq("id", Number(b.id)).select().single(); must(error); return json({ item: data });
    }

    return json({ error: "不明な操作です" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 400);
  }
});
