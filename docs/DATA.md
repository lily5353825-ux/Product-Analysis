# 数据字典与导入契约

机器可读字段、主键与外键契约见 config/data-contract.json；该文件为本项目约定格式，尚未实现校验器。跨字段约束以本文为准。

所有 CSV 模板位于 data/templates，UTF-8 编码；日期 YYYY-MM-DD；时间使用带时区 ISO 8601；金额整数美分、比率 0–1。标为可空的字段空白表示未知，其他字段必填。ID 作为字符串，保留前导零。

| 表 | 唯一键 | 字段与含义 |
|---|---|---|
| products | sku | sku；walmart_item_id；name；currency（本 MVP USD）；launch_date；active（true/false） |
| campaigns | campaign_id | campaign_id；sku（关联 products）；name；status（active/paused/ended）；current_daily_budget_cents（可空，人工确认当前日预算）；budget_confirmed_at（可空，确认时间） |
| order_lines | order_id + line_id | order_id；line_id；sku；ordered_date；quantity；cancelled_quantity；item_subtotal_cents；discount_cents；cancelled_net_cents；refund_cents；updated_at |
| daily_plan | date + sku | date；sku；gmv_target_cents；orders_target（SKU 订单目标）；ad_budget_cents |
| ad_daily | date + campaign_id | date；campaign_id；impressions；clicks；spend_cents；attributed_orders；attributed_sales_cents；daily_budget_cap_cents（可空）；report_profile_id；updated_at |
| inventory_daily | date + sku | date；sku；available_units（可售库存，不含在途）；updated_at |
| action_log | action_id | action_id；sku；campaign_id（可空）；action_type（increase/decrease/adjust/hold）；reason；previous_daily_budget_cents（可空）；new_daily_budget_cents（可空）；executed_at；operator |

order_lines 的 quantity 为正整数；cancelled_quantity 为 0 至 quantity 的整数；其余金额非负，折扣不能超过原商品金额，取消净额不能超过折后金额；全部取消时 GMV 必须为 0，退款不能超过有效 GMV。允许免费商品。订单行在整个数据集中唯一，一行不能重复归属多个 SKU。

ad_daily 的计数均为非负整数，clicks <= impressions。平台报表如使用小数归因订单，需要显式升级数据契约，不能静默四舍五入。report_profile_id 必须匹配 config/business.json 中已确认的归因设置；只接受同一归因报表范围与模型的商品直接归因销售，不混入品牌光环归因数据。不把广告类型不同而口径不同的报表直接相加。

**MVP 限制：每个 campaign 只能推广这两款中的一个 SKU，且报表花费覆盖范围必须与该 SKU 一致。** 混投 campaign 应先拆分，或后续使用经验证的商品粒度花费报告；禁止把 campaign 总花费复制到两个 SKU。多个 campaign 可以属于同一 SKU。

daily_plan 应覆盖整个活动周期，每天两款各一条；计划中的 0 是明确的零目标或零预算。products 必须恰好包含两款有效商品，且与 business.json 一致。所有外键必须存在；不同币种和未知 SKU 拒绝导入。

## 导入行为（待实现）
1. 预览并校验字段、类型、唯一键、外键、业务日期和报表口径；任一错误整批拒绝，显示行号与原因。
2. 保存批次元信息：batch_id、表名、源文件校验值、导入时间、覆盖日期范围、profile、状态、每日报表完整性。不要保存客户姓名、地址或电话。
3. 相同文件校验值重复导入应跳过；新订单快照按 order_id + line_id 替换旧值，不累加。最新 updated_at 优先；同时间但不同内容拒绝。
4. 广告回补按 date + campaign_id 替换原值，保留导入审计；需明确覆盖范围。没有行不能当成零，完整报表中的零交易日由批次覆盖信息确认。
5. daily_plan 修改保留版本和生效时间；用于分析的周期预算保持可追溯，避免改写计划掩盖超支。
6. 截止日取相关表共同完整覆盖的最后日期；规则使用成熟广告日期区间，最新未成熟数据只用于观察。
7. 库存快照缺失/过期时，可展示销售结果，但禁止加预算。库存可售天数 = 最新 available_units / 最近 7 个完整日的平均销售件数；均值为零时为未知，而非无限库存。

归因配置的 attribution_maturity_days 应覆盖所选日期基准下完整归因回补周期及报告延迟；例如按点击日归属时，不能把报表刷新延迟直接当作归因成熟延迟。首次接入必须按实际 Walmart 报表确认，当前配置保持空值。
