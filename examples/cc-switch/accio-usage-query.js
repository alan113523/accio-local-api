({
  request: {
    url: "{{baseUrl}}".replace(/\/+$/, "").replace(/\/v1$/, "") + "/quota",
    method: "GET",
    headers: { "Authorization": "Bearer {{apiKey}}" }
  },
  extractor: function(response) {
    var valid = response &&
      (response.scope === "team" || response.scope === "personal") &&
      Number.isFinite(response.totalCredits) && response.totalCredits >= 0 &&
      Number.isFinite(response.usedCredits) && response.usedCredits >= 0 &&
      Number.isFinite(response.remainingCredits) && response.remainingCredits >= 0;
    if (!valid) {
      return {
        isValid: false,
        invalidMessage: response && response.error && response.error.message || "Accio 额度查询失败"
      };
    }
    return {
      isValid: true,
      planName: response.scope === "team" ? "Accio 团队订阅" : "Accio 个人订阅",
      remaining: response.remainingCredits,
      used: response.usedCredits,
      total: response.totalCredits,
      unit: "积分",
      extra: "已用 " + response.usedCredits + " / 总额 " + response.totalCredits
    };
  }
})
