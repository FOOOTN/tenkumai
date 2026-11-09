// 天空米：Stripe からの「支払い完了」通知を受けて、注文を「支払い済み」にし、メールで知らせる
// Supabase Edge Function「tenkumai-webhook」（JWT 確認オフ：Stripe が呼ぶため。署名で本物か確かめる）
// Stripe（村の音 天空米アカウント）の Webhook に、このURLと checkout.session.completed / checkout.session.expired を登録する
// Secrets：TENKU_STRIPE_SECRET_KEY・TENKU_STRIPE_WEBHOOK_SECRET（whsec_…）、メール通知は tenkumai-checkout と同じ
import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const yen = (n: number) => n.toLocaleString("ja-JP") + "円";
const PAY_LABEL: Record<string, string> = { card: "クレジットカード", bank: "銀行振込", cod: "代金引換" };

async function sendMail(to: string[], subject: string, text: string) {
  const key = Deno.env.get("TENKU_RESEND_API_KEY"), from = Deno.env.get("TENKU_MAIL_FROM");
  const list = to.filter(Boolean);
  if (!key || !from || !list.length) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: list, subject, text }),
  });
  return r.ok;
}
function orderText(o: any) {
  const c = o.customer || {};
  const lines = (o.items || []).map((i: any) => `・${i.name} × ${i.q}　${yen(i.price * i.q)}`).join("\n");
  return `注文番号：${o.order_no}\n支払い方法：${PAY_LABEL[o.pay_method] || o.pay_method}（支払い済み）\n\n${lines}\n\n小計：${yen(o.subtotal)}\nわりびき：−${yen(o.discount)}\n送料：${yen(o.shipping)}\nお支払い：${yen(o.total)}\n\n【お届け先】\n${c.name || ""}（${c.kana || ""}）様\n〒${c.zip || ""} ${c.addr || ""}\n電話：${c.tel || ""}\nメール：${c.mail || ""}\n配達希望時間：${c.time || "指定なし"}\n備考：${o.note || "なし"}`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const key = Deno.env.get("TENKU_STRIPE_SECRET_KEY"), secret = Deno.env.get("TENKU_STRIPE_WEBHOOK_SECRET");
  if (!key || !secret) return new Response("not configured", { status: 503 });
  const stripe = new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(await req.text(), req.headers.get("stripe-signature") || "", secret, undefined, Stripe.createSubtleCryptoProvider());
  } catch (e) {
    return new Response("bad signature: " + (e as Error).message, { status: 400 });
  }
  try {
    const s = event.data.object as Stripe.Checkout.Session;
    if (s?.metadata?.site !== "tenkumai") return new Response("ignored");
    const no = s.metadata.orderNo;
    if (event.type === "checkout.session.completed" && s.payment_status === "paid") {
      const { data: o } = await db.from("tenkumai_orders").update({ status: "paid", paid_at: new Date().toISOString() })
        .eq("order_no", no).eq("status", "pending").select().maybeSingle();
      if (o) {
        const head = o.test ? "【テスト】" : "";
        const staff = (Deno.env.get("TENKU_NOTIFY_TO") || "").split(",").map((x) => x.trim());
        await sendMail(staff, `${head}天空米のご注文（カード決済済み） ${o.order_no}`, `天空米に新しいご注文が入りました。\n\n${orderText(o)}`).catch(() => {});
        if (o.customer?.mail) await sendMail([o.customer.mail], `${head}【天空米】ご注文ありがとうございます（${o.order_no}）`,
          `${o.customer.name || ""} 様\n\n天空米をご注文いただき、ありがとうございます。お支払いを確認しました。\n\n${orderText(o)}\n\n販売：富山商会`).catch(() => {});
      }
    } else if (event.type === "checkout.session.expired") {
      await db.from("tenkumai_orders").update({ status: "canceled" }).eq("order_no", no).eq("status", "pending");
    }
    return new Response("ok");
  } catch (e) {
    return new Response("error: " + (e as Error).message, { status: 500 });
  }
});
