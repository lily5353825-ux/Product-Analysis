# Product-Analysis

Walmart 两款新品沙发推广看板的 MVP 实施基础。

## 当前交付
- [MVP 页面与实施方案](docs/MVP.md)：模块、目标差距、实现顺序与验收标准。
- [数据字典](docs/DATA.md)、[机器可读字段契约](config/data-contract.json)及 [CSV 空模板](data/templates/)：字段、粒度、导入约束。
- [指标口径](docs/METRICS.md)及 [可执行计算模块](src/domain/metrics.mjs)。
- [预算与广告操作规则](docs/RULES.md)及 [规则参数](config/rules.json)。
- [业务配置](config/business.json)：两款商品、时区、归因口径、目标待补齐；美国站/USD 为待确认初始假设。
- [部署说明](docs/DEPLOYMENT.md)。

**目前完成方案、配置、模板和计算基础；尚未实现可视化页面、CSV 导入器、规则执行引擎或线上部署。** 本仓库不连接 Walmart API，不自动改动广告账户。

## 本地验证
安装 Node.js 22 或更高版本，无第三方依赖：
```sh
node --test
```
测试使用合成订单；不代表实际经营结果。

## 启动真实业务前
1. 填写 config/business.json：真实 Walmart item ID、SKU、报表时区与币种、广告归因来源/窗口/日期基准/成熟延迟。
2. 在商品配置填写目标 ACOS、目标 TACOS、目标 CPA、毛利率；确认这些值的业务依据。金额统一使用美分。
3. 按 data/templates 填写每日目标、预算、订单、广告和库存。空白不是零；广告数据不可用时显示“缺数据”。
4. 确认规则阈值后将 configuration_status 改为 ready；实现导入校验通过后才能生成建议。

不要把真实订单、访问密钥或经营报表提交到 Git。仓库内只保留模板及合成测试数据。下一步开发从 docs/MVP.md 的第 2 步开始。
