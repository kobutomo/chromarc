// AWS コンソールのページからアカウント ID を読み取り、サイドバーでのグループ分け用に伝える。
// (マルチセッション有効時は URL にアカウント ID が入るので、これは URL から分からない場合の補助)
(() => {
  function detect() {
    let id = null;
    let alias = null;
    try {
      const meta = document.querySelector('meta[name="awsc-session-data"]');
      if (meta) {
        const data = JSON.parse(meta.content);
        id = data.accountId ?? null;
        alias = data.accountAlias || null;
      }
    } catch {
      // 形式が違う場合は次の方法を試す
    }
    if (!id) {
      try {
        const match = document.cookie.match(/(?:^|;\s*)aws-userInfo=([^;]+)/);
        if (match) {
          const info = JSON.parse(decodeURIComponent(match[1]));
          id = info.arn?.match(/::(\d{12}):/)?.[1] ?? null;
          alias = info.alias || null;
        }
      } catch {
        // 読み取れなければ「アカウント不明」として扱われる
      }
    }
    if (!/^\d{12}$/.test(String(id ?? ''))) return null;
    return { id: String(id), alias: alias && alias !== String(id) ? String(alias) : null };
  }

  let tries = 0;
  const timer = setInterval(() => {
    const account = detect();
    if (!account && ++tries < 10) return;
    clearInterval(timer);
    if (account) chrome.runtime.sendMessage({ type: 'awsAccount', ...account }, () => void chrome.runtime.lastError);
  }, 1000);
})();
