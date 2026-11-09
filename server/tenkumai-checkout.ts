// 天空米：商品の取得・注文の受付・カード決済（サイトの index.html / checkout.html から呼ぶ）
// Supabase Edge Function「tenkumai-checkout」（JWT 確認オフ：ログインなしのお客さんが使うため）
// 決済：Stripe Connect のデスティネーション支払い（支払額の5%が運営者＝照櫟VorDX、残りが販売者＝富山商会）
// Secrets：TENKU_STRIPE_SECRET_KEY・TENKU_SELLER_ACCOUNT_ID・TENKU_SITE_URL（任意）
//          メール通知（任意）：TENKU_RESEND_API_KEY・TENKU_MAIL_FROM・TENKU_NOTIFY_TO（カンマ区切り）
// データ：public.tenkumai_products / tenkumai_orders / tenkumai_news（service role でのみ読み書き）
import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const PLATFORM_FEE_RATE = 0.05;   // 運営手数料 5%（送料を除く支払額）
const COUPON_YEN = 100, COUPON_MAX = 3;
const SHIPPING_YEN = 0;           // 送料（決まったら設定。送料は手数料の対象外で、全額が富山商会へ）
const PAY_LABEL: Record<string, string> = { card: "クレジットカード", bank: "銀行振込", cod: "代金引換" };
const yen = (n: number) => n.toLocaleString("ja-JP") + "円";

function orderNo() {
  const d = new Date(Date.now() + 9 * 3600e3);
  const p = (n: number) => String(n).padStart(2, "0");
  const r = crypto.getRandomValues(new Uint32Array(1))[0].toString(36).toUpperCase().slice(0, 4).padStart(4, "0");
  return `TK${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${r}`;
}

export async function sendMail(to: string[], subject: string, text: string) {
  const key = Deno.env.get("TENKU_RESEND_API_KEY"), from = Deno.env.get("TENKU_MAIL_FROM");
  const list = to.filter(Boolean);
  if (!key || !from || !list.length) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: list, subject, text }),
  });
  return r.ok;
}
export function orderText(o: any) {
  const c = o.customer || {};
  const lines = (o.items || []).map((i: any) => `・${i.name} × ${i.q}　${yen(i.price * i.q)}`).join("\n");
  return `注文番号：${o.order_no}\n支払い方法：${PAY_LABEL[o.pay_method] || o.pay_method}\n\n${lines}\n\n小計：${yen(o.subtotal)}\nわりびき：−${yen(o.discount)}\n送料：${yen(o.shipping)}\nお支払い：${yen(o.total)}\n\n【お届け先】\n${c.name || ""}（${c.kana || ""}）様\n〒${c.zip || ""} ${c.addr || ""}\n電話：${c.tel || ""}\nメール：${c.mail || ""}\n配達希望時間：${c.time || "指定なし"}\n備考：${o.note || "なし"}`;
}
export async function notifyNew(o: any) {
  const staff = (Deno.env.get("TENKU_NOTIFY_TO") || "").split(",").map((s) => s.trim());
  const head = o.test ? "【テスト】" : "";
  await sendMail(staff, `${head}天空米のご注文 ${o.order_no}`, `天空米に新しいご注文が入りました。\n\n${orderText(o)}`).catch(() => {});
  if (o.customer?.mail) await sendMail([o.customer.mail], `${head}【天空米】ご注文ありがとうございます（${o.order_no}）`,
    `${o.customer.name || ""} 様\n\n天空米をご注文いただき、ありがとうございます。\n\n${orderText(o)}\n\n販売：富山商会`).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const action = body.action || new URL(req.url).searchParams.get("action") || "catalog";

    // ---- 商品とお知らせ（サイトの表示用） ----
    if (action === "catalog") {
      const [{ data: products, error: e1 }, { data: news, error: e2 }] = await Promise.all([
        db.from("tenkumai_products").select("sku,variety,size,name,price,tentative,sold_out,sort").eq("active", true).order("sort"),
        db.from("tenkumai_news").select("id,body,created_at").eq("published", true).order("created_at", { ascending: false }).limit(5),
      ]);
      if (e1 || e2) throw new Error((e1 || e2)!.message);
      return json({ products, news });
    }

    if (action !== "order") return json({ error: "不明な操作です" }, 400);

    // ---- 注文の受付 ----
    const pay = String(body.pay || "");
    if (!PAY_LABEL[pay]) return json({ error: "支払い方法を選んでください" }, 400);
    const cu = body.customer || {};
    const s = (v: unknown, n = 200) => String(v ?? "").trim().slice(0, n);
    const customer = { name: s(cu.name, 60), kana: s(cu.kana, 60), tel: s(cu.tel, 20), mail: s(cu.mail, 120), zip: s(cu.zip, 10), addr: s(cu.addr, 200), time: s(cu.time, 20) };
    if (!customer.name || !customer.tel || !customer.zip || !customer.addr || !/^[^@\s]+@[^@\s]+$/.test(customer.mail))
      return json({ error: "お届け先の必須項目を入力してください" }, 400);

    const want = (body.items ?? []).map((i: any) => ({ sku: s(i.sku, 40), q: Math.floor(Number(i.q)) }));
    if (!want.length || want.some((i: any) => !(i.q >= 1 && i.q <= 50))) return json({ error: "かごの中身を確かめてください" }, 400);
    const { data: prods, error: pe } = await db.from("tenkumai_products").select("sku,name,price,sold_out,active").in("sku", want.map((i: any) => i.sku));
    if (pe) throw new Error(pe.message);
    const items = want.map((i: any) => {
      const p = prods!.find((x) => x.sku === i.sku);
      if (!p || !p.active) throw new Error("取り扱いのない商品が含まれています");
      if (p.sold_out) throw new Error(`「${p.name}」は売り切れました`);
      return { sku: p.sku, name: p.name, price: p.price, q: i.q };
    });
    const subtotal = items.reduce((a: number, i: any) => a + i.price * i.q, 0);
    const coupons = Math.max(0, Math.min(COUPON_MAX, Math.floor(Number(body.coupons) || 0)));
    const discount = Math.min(subtotal, coupons * COUPON_YEN);
    const shipping = SHIPPING_YEN;
    const paid = subtotal - discount;
    const fee = Math.floor(paid * PLATFORM_FEE_RATE);
    const key = Deno.env.get("TENKU_STRIPE_SECRET_KEY") || "";
    const test = !key.startsWith("sk_live_");

    const row = {
      order_no: orderNo(), status: pay === "card" ? "pending" : "received", pay_method: pay, items,
      subtotal, discount, shipping, total: paid + shipping, fee_rate: PLATFORM_FEE_RATE, platform_fee: fee,
      seller_amount: paid + shipping - fee, customer, note: s(body.note, 500) || null, test,
    };
    const { data: order, error: oe } = await db.from("tenkumai_orders").insert(row).select().single();
    if (oe) throw new Error(oe.message);

    if (pay !== "card") { await notifyNew(order); return json({ orderNo: order.order_no, total: order.total }); }

    // ---- カード決済：Stripe の支払い画面へ ----
    const seller = Deno.env.get("TENKU_SELLER_ACCOUNT_ID");
    if (!key || !seller) return json({ error: "カード決済の準備ができていません（運営者の設定待ち）" }, 503);
    const site = (Deno.env.get("TENKU_SITE_URL") || req.headers.get("origin") || "").replace(/\/$/, "");
    if (!/^https?:\/\//.test(site)) return json({ error: "サイトのURLがわかりません" }, 400);
    const stripe = new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
    const discounts = discount > 0
      ? [{ coupon: (await stripe.coupons.create({ amount_off: discount, currency: "jpy", duration: "once", name: "村の地図 わりびきけん" })).id }]
      : [];
    const session = await stripe.checkout.sessions.create({
      mode: "payment", locale: "ja",
      line_items: items.map((i: any) => ({ quantity: i.q, price_data: { currency: "jpy", unit_amount: i.price, product_data: { name: i.name } } })),
      discounts,
      customer_email: customer.mail,
      payment_intent_data: {
        application_fee_amount: fee,              // → 照櫟VorDX
        transfer_data: { destination: seller },   // 残り → 富山商会
        metadata: { site: "tenkumai", orderNo: order.order_no },
      },
      metadata: { site: "tenkumai", orderNo: order.order_no },
      success_url: `${site}/checkout.html?paid=1&order=${encodeURIComponent(order.order_no)}`,
      cancel_url: `${site}/checkout.html?canceled=1&order=${encodeURIComponent(order.order_no)}`,
    });
    await db.from("tenkumai_orders").update({ stripe_session_id: session.id }).eq("id", order.id);
    return json({ orderNo: order.order_no, url: session.url });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 400);
  }
});
