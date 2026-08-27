# 查看邮件 API

## 通过 邮件 API 查看邮件

这是一个 `python` 的例子，使用 `requests` 库查看邮件。

```python
limit = 10
offset = 0
res = requests.get(
    f"https://<你的worker地址>/api/mails?limit={limit}&offset={offset}",
    headers={
        "Authorization": f"Bearer {你的JWT密码}",
        # "x-custom-auth": "<你的网站密码>", # 如果启用了私有站点密码
        "Content-Type": "application/json"
    }
)
```

**注意**：`/api/mails` 按设计返回的是原始 RFC822 数据（如 `source`/`raw`），不保证直接包含 `subject`、`text`、`html` 等已解析字段。若要直接读取正文，请在客户端侧解析 `raw`（例如 `mail-parser-wasm`、`postal-mime`）。

## 邮件状态 API

完成数据库迁移后，可分别启用 `ENABLE_MAIL_READ_STATUS` 和 `ENABLE_MAIL_FLAGGED`。前者让邮件响应包含 `unread`，后者包含 `flagged`；两个开关互不依赖。邮件状态保存在独立的稀疏关联表中，不修改 `raw_mails`；没有状态记录的历史邮件默认已读且未星标，状态计算和更新全部由后端处理。

已读状态是高写入量功能：启用后每封新邮件会新增一条未读记录，邮件变为已读时再删除。仅启用星标不会执行这些写入，只有用户添加或取消星标时才修改数据库。

地址 JWT 使用 `GET /api/mail-states` 获取当前可用的已读状态。前端直接使用其中的 `value` 作为筛选和更新参数，并使用 `label_key` 显示名称。

使用 `PATCH /api/mails/state` 批量移动邮件状态，每次最多传入 100 个邮件 ID：

```python
requests.patch(
    "https://<你的worker地址>/api/mails/state",
    headers={"Authorization": "Bearer <你的JWT密码>"},
    json={"ids": [1, 2], "state": "read"}
)
```

用户 JWT 使用 `GET /user_api/mail-states` 和 `PATCH /user_api/mails/state`，只能修改该用户已绑定地址的邮件。接口返回更新后的 `unread` 状态。

星标与已读状态相互独立。使用 `PATCH /api/mails/flagged` 添加或取消星标：

```python
requests.patch(
    "https://<你的worker地址>/api/mails/flagged",
    headers={"Authorization": "Bearer <你的JWT密码>"},
    json={"ids": [1, 2], "flagged": True}
)
```

用户 JWT 对应接口为 `PATCH /user_api/mails/flagged`。

邮件列表使用后端返回的状态 `value` 查询。例如查询未读邮件：

```text
GET /api/mails?limit=20&offset=0&mail_state=unread
```

使用 `flagged=true` 查询星标邮件，并可与 `mail_state` 组合：

```text
GET /api/mails?limit=20&offset=0&mail_state=unread&flagged=true
```

`/user_api/mails` 支持相同参数。

## admin 邮件 API

支持 `address` 过滤

```python
import requests

url = "https://<你的worker地址>/admin/mails"

querystring = {
    "limit":"20",
    "offset":"0",
    # address 为可选参数
    "address":"xxxx@awsl.uk"
}

headers = {
        "x-admin-auth": "<你的Admin密码>",
        # "x-custom-auth": "<你的网站密码>", # 如果启用了私有站点密码
    }

response = requests.get(url, headers=headers, params=querystring)

print(response.json())
```

**注意**：`/admin/mails` 与 `/api/mails` 一致，返回的是邮件数据库中的 raw MIME 内容；如需正文/主题等可读字段，请在客户端自行解析 `raw`。

**注意**：后端 API 已移除关键词过滤功能。如需按内容过滤邮件，请使用前端界面的过滤输入框，该功能可过滤当前显示的页面。

## admin 获取单封邮件 API

无需邮箱 JWT，通过邮件 ID 获取单封邮件，并使用 `x-admin-auth` 认证。
返回结构与 `/admin/mails` 中的单条记录一致：gzip 压缩的原始邮件会解压到 `raw`，响应不包含 `raw_blob`。

```python
import requests

mail_id = 1
url = f"https://<你的worker地址>/admin/mails/{mail_id}"

headers = {
        "x-admin-auth": "<你的Admin密码>",
        # "x-custom-auth": "<你的网站密码>", # 如果启用了私有站点密码
    }

response = requests.get(url, headers=headers)

print(response.json())
```

## admin 删除邮件 API

通过邮件 ID 删除单封邮件。

```python
import requests

mail_id = 1
url = f"https://<你的worker地址>/admin/mails/{mail_id}"

headers = {
        "x-admin-auth": "<你的Admin密码>",
        # "x-custom-auth": "<你的网站密码>", # 如果启用了私有站点密码
    }

response = requests.delete(url, headers=headers)

print(response.json())
```

## admin 删除邮箱地址 API

通过邮箱地址 ID 删除邮箱地址（同时删除该地址关联的邮件、发件权限和用户绑定）。

```python
import requests

address_id = 1
url = f"https://<你的worker地址>/admin/delete_address/{address_id}"

headers = {
        "x-admin-auth": "<你的Admin密码>",
        # "x-custom-auth": "<你的网站密码>", # 如果启用了私有站点密码
    }

response = requests.delete(url, headers=headers)

print(response.json())
```

## admin 清空收件箱 API

通过邮箱地址 ID 清空该地址的所有收件。

```python
import requests

address_id = 1
url = f"https://<你的worker地址>/admin/clear_inbox/{address_id}"

headers = {
        "x-admin-auth": "<你的Admin密码>",
        # "x-custom-auth": "<你的网站密码>", # 如果启用了私有站点密码
    }

response = requests.delete(url, headers=headers)

print(response.json())
```

## admin 清空发件箱 API

通过邮箱地址 ID 清空该地址的所有发件。

```python
import requests

address_id = 1
url = f"https://<你的worker地址>/admin/clear_sent_items/{address_id}"

headers = {
        "x-admin-auth": "<你的Admin密码>",
        # "x-custom-auth": "<你的网站密码>", # 如果启用了私有站点密码
    }

response = requests.delete(url, headers=headers)

print(response.json())
```

## user 邮件 API

::: warning 注意：用户 JWT vs 地址 JWT
此接口使用**用户 JWT**（通过 `/user_api/login` 或 `/user_api/register` 获得），使用 `x-user-token` header。

**请勿与地址 JWT 混淆**：
- 地址 JWT 使用 `Authorization: Bearer <jwt>` 访问 `/api/*` 接口
- 用户 JWT 使用 `x-user-token: <jwt>` 访问 `/user_api/*` 接口
:::

### 用户绑定地址列表

`GET /user_api/bind_address` 使用服务端分页，支持以下查询参数：

未携带分页参数时返回默认第一页，不支持一次获取全部绑定地址。

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `limit` | `20` | 每页数量，范围为 1–100 |
| `offset` | `0` | 分页偏移量 |

响应中的 `results` 仅包含当前页。仅 `offset=0` 时查询总数，后续页面的 `count` 为 `0`，客户端应保留第一页返回的总数。

```python
import requests

url = "https://<你的worker地址>/user_api/bind_address"
headers = {
    "x-user-token": "<你的用户JWT Token>",
}
querystring = {
    "limit": "20",
    "offset": "0",
}
response = requests.get(url, headers=headers, params=querystring)
print(response.json())
```

### 用户邮件列表

支持 `address` 过滤

```python
import requests

url = "https://<你的worker地址>/user_api/mails"

querystring = {
    "limit":"20",
    "offset":"0",
    # address 为可选参数
    "address":"xxxx@awsl.uk"
}

headers = {
        "x-user-token": "<你的用户JWT Token>",
        # "x-custom-auth": "<你的网站密码>", # 如果启用了私有站点密码
    }

response = requests.get(url, headers=headers, params=querystring)

print(response.json())
```

**注意**：`/user_api/mails` 同样返回原始 RFC822 内容；请在客户端解析后提取 `subject`、`text`、`html`。

**注意**：后端 API 已移除关键词过滤功能。如需按内容过滤邮件，请使用前端界面的过滤输入框，该功能可过滤当前显示的页面。
