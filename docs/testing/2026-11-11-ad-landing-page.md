# 投流落地页验证

日期：2026-11-11

## 浏览器验证

环境：`http://localhost:5174/?utm_source=test&utm_campaign=spring#/lp`，Chrome，公开 API。

- 落地页进入后左侧栏与顶栏隐藏，独立落地页头显示。
- Hero：主推内容「咖啡跑」，评分 8.4、2020、短剧、荷兰；主 CTA「立即观看」，次 CTA「查看会员」。
- 价值点、本期精选、三个真实会员套餐（¥25/30 天、¥68/90 天、¥238/365 天）和 FAQ 正常渲染。
- 英文切换后静态文案切换为英文，内容标题/简介保持原内容语言。
- 点击「立即观看」进入 `#/drama/1`，UTM 参数保留，常规侧栏/顶栏恢复。
- 390×844：`scrollWidth 375 <= innerWidth 390`，主 CTA 宽 339px，无横向溢出。

## 埋点验证

```text
lp_view       2 条，meta {"campaign":"spring"}，path "#/lp"
lp_cta_click  1 条，drama_id 1，meta {"target":"watch"}
```

`/api/plans` 已加入公开路径，落地页未登录时也能展示套餐价格。

## 限制

- 当前主推内容来自首页 Banner/精选，`?dramaId=` 可指定首页已有内容；不在首页片库中的内容需先加入首页运营位。
- 未接 A/B 实验后台；版本区分使用 `utm_content`。
