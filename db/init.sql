-- HRMS Taiwan Local Database Schema
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. 部門資料表 (Departments)
CREATE TABLE IF NOT EXISTS departments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL UNIQUE,
    code VARCHAR(20) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. 員工主檔資料表 (Employees)
CREATE TABLE IF NOT EXISTS employees (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    employee_no VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL DEFAULT 'password_hash_placeholder',
    role VARCHAR(20) NOT NULL DEFAULT 'employee', -- admin, hr, manager, employee
    department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
    manager_id UUID REFERENCES employees(id) ON DELETE SET NULL,
    job_title VARCHAR(100),
    phone VARCHAR(30),
    id_number VARCHAR(20), -- 身分證字號 (加密或存取控制)
    bank_account VARCHAR(50), -- 銀行轉帳帳號
    bank_code VARCHAR(10), -- 銀行代碼 (如 812 台新, 013 國泰)
    
    -- 薪資與投保級距資訊 (台灣法規必備)
    base_salary NUMERIC(10, 2) NOT NULL DEFAULT 0, -- 底薪
    fixed_allowance NUMERIC(10, 2) NOT NULL DEFAULT 0, -- 固定津貼
    labor_insurance_grade NUMERIC(10, 2) DEFAULT 0, -- 勞保投保級距
    health_insurance_grade NUMERIC(10, 2) DEFAULT 0, -- 健保投保級距
    dependents_count INT DEFAULT 0, -- 健保眷屬人數
    labor_pension_self_rate NUMERIC(5, 2) DEFAULT 0, -- 勞退自提比例 (0% ~ 6%)
    
    hire_date DATE NOT NULL,
    resign_date DATE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. 打卡出勤紀錄表 (Attendance Logs)
CREATE TABLE IF NOT EXISTS attendance_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    clock_in TIMESTAMP WITH TIME ZONE,
    clock_out TIMESTAMP WITH TIME ZONE,
    clock_in_location VARCHAR(255), -- 地理位置描述
    clock_in_lat NUMERIC(10, 7), -- GPS 緯度
    clock_in_lng NUMERIC(10, 7), -- GPS 經度
    clock_in_photo_url TEXT, -- 拍照驗證 URL
    duty_type VARCHAR(20) DEFAULT 'office', -- office, field, remote
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. 請假申請與簽核表 (Leave Requests)
CREATE TABLE IF NOT EXISTS leave_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    leave_type VARCHAR(30) NOT NULL, -- annual(特休), sick(病假), personal(事假), marital(婚假), bereavement(喪假), maternity(產假), paternity(陪產假)
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time TIMESTAMP WITH TIME ZONE NOT NULL,
    total_hours NUMERIC(5, 2) NOT NULL,
    reason TEXT,
    status VARCHAR(20) DEFAULT 'pending', -- pending, approved, rejected, cancelled
    reviewer_id UUID REFERENCES employees(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    reviewer_comment TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. 月度薪資結算表 (Payroll Records)
CREATE TABLE IF NOT EXISTS payroll_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    payroll_month VARCHAR(7) NOT NULL, -- 格式 'YYYY-MM' (例如 '2026-07')
    
    base_salary NUMERIC(10, 2) NOT NULL,
    allowances NUMERIC(10, 2) DEFAULT 0,
    overtime_pay NUMERIC(10, 2) DEFAULT 0, -- 加班費
    leave_deduction NUMERIC(10, 2) DEFAULT 0, -- 請假扣款
    gross_salary NUMERIC(10, 2) NOT NULL, -- 應發總額
    
    -- 台灣法定扣繳項目
    labor_insurance_employee NUMERIC(10, 2) DEFAULT 0, -- 勞保自付
    health_insurance_employee NUMERIC(10, 2) DEFAULT 0, -- 健保自付
    labor_pension_self NUMERIC(10, 2) DEFAULT 0, -- 勞退自提
    withholding_tax NUMERIC(10, 2) DEFAULT 0, -- 預扣所得稅
    supplementary_premium NUMERIC(10, 2) DEFAULT 0, -- 二代健保補充保費
    total_deductions NUMERIC(10, 2) NOT NULL, -- 扣繳合計
    
    net_salary NUMERIC(10, 2) NOT NULL, -- 實發金額
    
    -- 雇主負擔項目 (成本統計)
    labor_insurance_employer NUMERIC(10, 2) DEFAULT 0,
    health_insurance_employer NUMERIC(10, 2) DEFAULT 0,
    labor_pension_employer NUMERIC(10, 2) DEFAULT 0,
    
    status VARCHAR(20) DEFAULT 'draft', -- draft, approved, paid
    paid_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 插入測試範例資料 (Seed Data)
INSERT INTO departments (name, code) VALUES
('管理部', 'ADM'),
('資訊研發部', 'RD'),
('業務行銷部', 'MKT')
ON CONFLICT (name) DO NOTHING;

-- 插入範例管理員帳號
INSERT INTO employees (
    employee_no, name, email, role, job_title, base_salary, fixed_allowance, 
    labor_insurance_grade, health_insurance_grade, hire_date
) VALUES (
    'EMP001', '系統管理員', 'admin@company.local', 'admin', 'CEO / 管理員', 
    100000, 10000, 45800, 45800, '2024-01-01'
) ON CONFLICT (employee_no) DO NOTHING;
