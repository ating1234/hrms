const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER || 'hrms_admin',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'hrms_db',
  password: process.env.DB_PASSWORD || 'LocalStrongPassword123!',
  port: parseInt(process.env.DB_PORT || '5432', 10),
});

const familyNames = ['陳', '林', '黃', '張', '李', '王', '吳', '劉', '蔡', '楊', '許', '鄭', '謝', '郭', '洪', '曾', '邱', '廖', '賴', '周'];
const firstNames = ['家豪', '志明', '建宏', '俊傑', '冠宇', '威宇', '柏翰', '承翰', '冠廷', '宗翰', '雅婷', '怡君', '婷婷', '佩珊', '佳穎', '淑芬', '靜宜', '惠雯', '美玲', '雅琪'];

const deptDefs = [
  { name: '總經理室', code: 'ADM', managerTitle: '總經理' },
  { name: '人事行政部', code: 'HR', managerTitle: 'HR 協理' },
  { name: '財務會計部', code: 'FIN', managerTitle: '財務長 (CFO)' },
  { name: '資訊研發部', code: 'RD', managerTitle: '技術總監 (CTO)' },
  { name: '業務行銷部', code: 'MKT', managerTitle: '業務總監' },
  { name: '客服運營部', code: 'CS', managerTitle: '客服營運主管' },
];

const titles = ['高級工程師', '資深專員', '產品經理', '專員', '助理', '資深設計師', '行銷企劃', '資深會計', '資深客服'];

async function seed50Employees() {
  try {
    console.log('🚀 開始清理與升級 50 人組織架構與部門主管...');

    // 先清除依賴
    await pool.query(`DELETE FROM leave_requests;`);
    await pool.query(`DELETE FROM attendance_logs;`);
    await pool.query(`DELETE FROM payroll_records;`);
    await pool.query(`DELETE FROM employees;`);
    await pool.query(`DELETE FROM departments;`);

    // 重新創建 6 大標準部門
    const deptMap = {};
    for (const d of deptDefs) {
      const res = await pool.query(`INSERT INTO departments (name, code) VALUES ($1, $2) RETURNING id`, [d.name, d.code]);
      deptMap[d.code] = res.rows[0].id;
    }

    let empCounter = 0;

    // 1 位 CEO (Admin)
    empCounter++;
    const adminRes = await pool.query(`
      INSERT INTO employees (
        employee_no, name, email, role, department_id, job_title,
        base_salary, fixed_allowance, meal_allowance, transport_allowance, performance_bonus, festival_bonus,
        labor_pension_self_rate, hire_date
      ) VALUES ('EMP001', '系統管理員', 'admin@company.local', 'admin', $1, 'CEO / 管理員', 120000, 10000, 3000, 2000, 20000, 0, 0, '2023-01-15') RETURNING id
    `, [deptMap['ADM']]);
    const adminId = adminRes.rows[0].id;

    // 6 位部門主管 (Role: manager)
    const managerIds = [];
    const deptCodes = Object.keys(deptMap);

    for (let i = 0; i < deptCodes.length; i++) {
      const code = deptCodes[i];
      const deptId = deptMap[code];
      const def = deptDefs.find(d => d.code === code);
      empCounter++;
      const empNo = `EMP${String(empCounter).padStart(3, '0')}`;
      const surname = familyNames[i % familyNames.length];
      const name = `${surname}${firstNames[i % firstNames.length]}`;
      const email = `${empNo.toLowerCase()}@company.local`;
      const hireYear = 2012 + (i % 6);
      const hireDate = `${hireYear}-0${(i % 8) + 1}-15`;
      const baseSalary = 80000 + (i * 5000);

      const managerRes = await pool.query(`
        INSERT INTO employees (
          employee_no, name, email, role, department_id, manager_id, job_title,
          base_salary, fixed_allowance, meal_allowance, transport_allowance, performance_bonus, festival_bonus,
          labor_pension_self_rate, hire_date
        ) VALUES ($1, $2, $3, 'manager', $4, $5, $6, $7, 5000, 3000, 2000, 10000, 0, 6, $8) RETURNING id
      `, [empNo, name, email, deptId, adminId, def.managerTitle, baseSalary, hireDate]);

      managerIds.push({ deptId, managerId: managerRes.rows[0].id });
      console.log(`✅ 已建立部門主管：${name} (${def.managerTitle}) -> ${def.name}`);
    }

    // 填充其餘員工至精準 50 人 (Role: employee)
    while (empCounter < 50) {
      empCounter++;
      const empNo = `EMP${String(empCounter).padStart(3, '0')}`;
      const surname = familyNames[empCounter % familyNames.length];
      const fname = firstNames[(empCounter * 3) % firstNames.length];
      const name = `${surname}${fname}`;
      const email = `${empNo.toLowerCase()}@company.local`;
      
      const code = deptCodes[empCounter % deptCodes.length];
      const deptId = deptMap[code];
      const managerObj = managerIds.find(m => m.deptId === deptId);
      const jobTitle = titles[empCounter % titles.length];

      const year = 2010 + (empCounter % 16);
      const month = String((empCounter % 12) + 1).padStart(2, '0');
      const day = String((empCounter % 28) + 1).padStart(2, '0');
      const hireDate = `${year}-${month}-${day}`;

      const baseSalary = 38000 + ((empCounter % 15) * 2000);
      const transportAllowance = empCounter % 3 === 0 ? 1000 : 0;
      const pensionRate = empCounter % 2 === 0 ? 6 : 0;

      await pool.query(`
        INSERT INTO employees (
          employee_no, name, email, role, department_id, manager_id, job_title,
          base_salary, fixed_allowance, meal_allowance, transport_allowance, performance_bonus, festival_bonus,
          labor_pension_self_rate, hire_date
        ) VALUES ($1, $2, $3, 'employee', $4, $5, $6, $7, 2000, 3000, $8, 0, 0, $9, $10)
      `, [empNo, name, email, deptId, managerObj ? managerObj.managerId : adminId, jobTitle, baseSalary, transportAllowance, pensionRate, hireDate]);
    }

    console.log('🎉 成功生成精準 50 位包含 6 大部門主管的真實員工資料！');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seeding Error:', err);
    process.exit(1);
  }
}

seed50Employees();
