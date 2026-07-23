# 50 人規模台灣 HRMS 人事薪資系統架構與實作規劃書 (純本地 Colima Docker 版)

## 1. 專案定位與本地技術架構 (Local Architecture Overview)

本系統採 **100% 本地端 (Local-First)** 部署，資料完全留存於公司內部，無需任何雲端託管費用（無 Cloudflare / Vercel 依賴）。後端資料庫全面託管於 **Colima (Docker)** 容器中，方便維護與資料備份。

```
                       ┌──────────────────────────────────────────────┐
                       │     公司內網 / 本地端使用者介面 (Web / PWA)   │
                       │     React 19 + Tailwind CSS (localhost:3000) │
                       └──────────────────────┬───────────────────────┘
                                              │ 局域網 HTTP / REST API
                       ┌──────────────────────▼───────────────────────┐
                       │         本地後端 API 服務 (Node.js)          │
                       │   - 出勤/簽核 API     - `taiwan-payroll` 引擎 │
                       └──────────────────────┬───────────────────────┘
                                              │ PostgreSQL Connection
                       ┌──────────────────────▼───────────────────────┐
                       │       Colima Docker 容器管理環境              │
                       │ ┌──────────────────────────────────────────┐ │
                       │ │  PostgreSQL 16 容器 (Port 5432)          │ │
                       │ │  - 獨立掛載 Volume (資料持久化與備份)    │ │
                       │ ├──────────────────────────────────────────┤ │
                       │ │  pgAdmin / Adminer 容器 (Port 8080)     │ │
                       │ │  - 資料庫視覺化管理 UI                   │ │
                       │ └──────────────────────────────────────────┘ │
                       └──────────────────────────────────────────────┘
```

### 本地技術棧 (Local Tech Stack)
* **容器化環境 (Container)**：Colima + Docker Compose
* **資料庫 (Database)**：PostgreSQL 16 (運行於 Colima 容器) + Adminer / pgAdmin (GUI 管理)
* **前端與 API (Application)**：React 19, Node.js (TypeScript), Tailwind CSS
* **薪資計算引擎 (Payroll Engine)**：`taiwan-payroll` (npm 模組)
* **內網存取 (Local Network)**：公司局域網 LAN (如 `http://192.168.X.X:3000`) 或單機 `localhost`

---

## 2. Colima Docker 環境設定與 Compose 規劃

將 PostgreSQL 與資料庫管理介面整合至 `docker-compose.yml`，一鍵啟動：

```yaml
version: '3.8'

services:
  # 本地 PostgreSQL 資料庫
  postgres:
    image: postgres:16-alpine
    container_name: hrms_postgres
    restart: always
    environment:
      POSTGRES_DB: hrms_db
      POSTGRES_USER: hrms_admin
      POSTGRES_PASSWORD: LocalStrongPassword123!
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  # 資料庫管理 UI (方便 HR / IT 管理員視覺化查看)
  adminer:
    image: adminer
    container_name: hrms_adminer
    restart: always
    ports:
      - "8080:8080"

volumes:
  postgres_data:
```

---

## 3. 50 人規模公司之組織與權限設計 (User Roles)

| 角色名稱 | 代表人員 | 核心權限 |
| :--- | :--- | :--- |
| **Admin (系統管理員)** | CEO / IT 主管 | 系統全權存取、Colima 資料庫備份、權限設定、日誌查看。 |
| **HR / 財務** | 人資專員 (1-2人) | 員工主檔維護、假勤終審、薪資結算、匯出銀行轉帳檔、發送加密薪資單。 |
| **Manager (部門主管)** | 各部門 Team Lead | 審核組員請假/補簽/加班、查看組員出勤狀況。 |
| **Employee (一般員工)** | 40-45 名員工 | 內網打卡、申請請假/加班/補簽、查看個人出勤與薪資單。 |

---

## 4. 核心模組與業務流程設計 (Core Modules)

### 模組 1：員工主檔與組織管理 (Employee & Org)
* **個人與薪資檔案**：基本資料、銀行帳戶、基本薪資、固定津貼、勞健保級距與眷屬人數。
* **Colima DB 持久化**：所有員工敏感資料 100% 儲存在本地 Colima PostgreSQL，零雲端外洩風險。

### 模組 2：考勤與假勤管理 (Attendance & Leave)
* **內網打卡**：員工連接公司 Wi-Fi 或內網 IP 即可打卡，防止異地代打卡。
* **台灣勞基法假勤規則**：特休週年制、病假半薪、事假、婚喪產假等簽核流程。

### 模組 3：台灣薪資結算引擎 (Taiwan Payroll Engine)
整合 `taiwan-payroll` npm 套件，於本地 Node.js 執行：

$$ \text{實發薪資} = (\text{底薪} + \text{津貼} + \text{加班費} - \text{假勤扣款}) - \text{勞保自付} - \text{健保自付} - \text{預扣所得稅} $$

* **本地產出**：
  * **銀行網銀轉帳檔**：一鍵產生台灣各大銀行 (台新、國泰、玉山等) 文字檔/CSV。
  * **加密 PDF 薪資單**：本地生成密碼保護的 PDF 並透過公司本地 SMTP 發送。

---

## 5. 本地端資料備份與維護策略 (Backup & Maintenance)

因為採用 Colima Docker，資料備份極為簡單：

1. **自動每日 Cron 備份 (pg_dump)**：
   ```bash
   # 在 Mac 本地定期執行 pg_dump
   docker exec -t hrms_postgres pg_dump -U hrms_admin hrms_db > ~/hrs_backups/hrms_$(date +%Y%m%m).sql
   ```
2. **Volume 實體檔案備份**：可以直接備份 Colima 的 `postgres_data` 掛載點。

---

## 6. 階段式實作時程規劃 (Local Implementation Roadmap)

| 階段 | 主要任務 | 預估天數 |
| :--- | :--- | :--- |
| **Phase 1: Colima Docker 環境與資料庫** | 1. 啟動 Colima 並建立 `docker-compose.yml`<br>2. 運行 PostgreSQL & Adminer 容器<br>3. 建立 PostgreSQL Schema (Tables & RLS) | Day 1 - Day 2 |
| **Phase 2: 本地 OpenHRApp 啟動與連線** | 1. 將 OpenHRApp 連線至本地 PostgreSQL<br>2. 建立 50 人測試資料與內網打卡介面 | Day 3 - Day 4 |
| **Phase 3: 薪資模組 (taiwan-payroll)** | 1. 在本地端整合 `taiwan-payroll` npm 套件<br>2. 開發薪資計算與 HR 結算確認介面 | Day 5 - Day 7 |
| **Phase 4: 網銀轉帳檔與加密薪資單** | 1. 開發銀行 CSV 匯出功能<br>2. 開發加密 PDF 薪資單與本地 Email 發送 | Day 8 - Day 9 |
| **Phase 5: 內網測試與正式上線** | 1. 測試內網 IP 訪問與權限隔離<br>2. 設定每日自動 SQL 備份作業 | Day 10 |

---

## 7. 營運預算估算

* **伺服器/雲端託管費用**：**$0 元** (使用公司現有 Mac/PC 運行 Colima)
* **資料庫月租費**：**$0 元** (Colima Docker 本地運作)
* **總營運成本**：**NT$ 0 元 / 月**
