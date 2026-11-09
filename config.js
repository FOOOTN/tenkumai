/* 天空米サイトの設定（ここだけ書き換えれば、つなぎ先を変えられる） */
window.TENKU = {
  api: 'https://uhnilnjgydbmpfwesdpg.supabase.co/functions/v1',  // Supabase Edge Functions のURL（試作中は釣果海図ログのプロジェクトに同居）
  test: true                                                       // Stripe のテスト環境で動かしている間は true
};
