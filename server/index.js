const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// AES-256 全域二進位加密密鑰 (存放在伺服器環境變數 / 端點解密金鑰)
const DB_SECRET_KEY = process.env.DB_SECRET_KEY || 'HrmsLocalAes256SecretKey2026!';

// 連接 Colima Docker 中的 PostgreSQL
const pool = new Pool({
  user: process.env.DB_USER || 'hrms_admin',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'hrms_db',
  password: process.env.DB_PASSWORD || 'LocalStrongPassword123!',
  port: parseInt(process.env.DB_PORT || '5432', 10),
});

pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ PostgreSQL 連線失敗:', err.stack);
  } else {
    console.log('✅ 成功連線至 Colima PostgreSQL 資料庫 (Phase 1 勞工法規嚴格合規與變形班表開啟):', res.rows[0].now);
  }
});

// ----------------------------------------------------
// 🌟 台灣勞基法年資與特休假演算法
// ----------------------------------------------------
function calculateSeniorityAndLeave(hireDateStr) {
  if (!hireDateStr) return { seniorityText: '0 年 0 個月', totalDays: 0, monthsTotal: 0 };
  
  const hireDate = new Date(hireDateStr);
  const now = new Date();
  
  let years = now.getFullYear() - hireDate.getFullYear();
  let months = now.getMonth() - hireDate.getMonth();
  if (months < 0) {
    years--;
    months += 12;
  }
  const totalMonths = (years * 12) + months;
  const seniorityText = `${years} 年 ${months} 個月`;

  let totalDays = 0;
  if (totalMonths >= 6 && totalMonths < 12) {
    totalDays = 3;
  } else if (totalMonths >= 12 && totalMonths < 24) {
    totalDays = 7;
  } else if (totalMonths >= 24 && totalMonths < 36) {
    totalDays = 10;
  } else if (totalMonths >= 36 && totalMonths < 60) {
    totalDays = 14;
  } else if (totalMonths >= 60 && totalMonths < 120) {
    totalDays = 15;
  } else if (totalMonths >= 120) {
    const extraYears = Math.floor((totalMonths - 120) / 12);
    totalDays = Math.min(30, 15 + extraYears + 1);
  }

  return { seniorityText, totalDays, monthsTotal: totalMonths };
}

// Helper: 針對一般員工與主管隱藏敏感薪資
function sanitizeEmployeeSensitiveData(emp, isAuthorized) {
  if (isAuthorized) return emp;
  return {
    ...emp,
    base_salary: '***',
    fixed_allowance: '***',
    meal_allowance: '***',
    transport_allowance: '***',
    performance_bonus: '***',
    festival_bonus: '***',
    bank_account: '***'
  };
}

// ----------------------------------------------------
// 1. 班表維護與動態變形工時 API (Phase 1 新增)
// ----------------------------------------------------

app.get('/api/shifts', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM shifts WHERE is_active = TRUE ORDER BY start_time ASC`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error fetching shifts' });
  }
});

// ----------------------------------------------------
// 2. 部門與員工 API (使用 pgcrypto 動態 AES-256 解密)
// ----------------------------------------------------

app.get('/api/departments', async (req, res) => {
  const { requester_id } = req.query;
  try {
    let isAuthorized = false;
    if (requester_id) {
      const reqEmp = (await pool.query(`SELECT role FROM employees WHERE id = $1`, [requester_id])).rows[0];
      if (reqEmp && (reqEmp.role === 'admin' || reqEmp.role === 'hr')) isAuthorized = true;
    }

    const deptResult = await pool.query(`
      SELECT d.*, COUNT(e.id)::int as employee_count 
      FROM departments d 
      LEFT JOIN employees e ON d.id = e.department_id AND e.is_active = TRUE
      GROUP BY d.id 
      ORDER BY 
        CASE WHEN d.code = 'ADM' THEN 0 ELSE 1 END,
        d.code ASC
    `);

    const employees = (await pool.query(`
      SELECT e.id, e.employee_no, e.name, e.job_title, e.role, e.email, e.department_id, e.manager_id, e.hire_date,
             COALESCE(pgp_sym_decrypt(e.base_salary_encrypted, $1), '0') as base_salary,
             COALESCE(pgp_sym_decrypt(e.meal_allowance_encrypted, $1), '3000') as meal_allowance,
             COALESCE(pgp_sym_decrypt(e.transport_allowance_encrypted, $1), '0') as transport_allowance,
             COALESCE(pgp_sym_decrypt(e.performance_bonus_encrypted, $1), '0') as performance_bonus,
             COALESCE(pgp_sym_decrypt(e.festival_bonus_encrypted, $1), '0') as festival_bonus,
             e.fixed_allowance, e.labor_pension_self_rate, e.bank_code, e.bank_account
      FROM employees e 
      WHERE e.is_active = TRUE 
      ORDER BY e.employee_no ASC
    `, [DB_SECRET_KEY])).rows;

    const leaves = (await pool.query(`SELECT * FROM leave_requests WHERE leave_type = 'annual' AND status = 'approved'`)).rows;

    const employeesWithSeniority = employees.map(emp => {
      const { seniorityText, totalDays } = calculateSeniorityAndLeave(emp.hire_date);
      const usedLeaveHours = leaves
        .filter(l => l.employee_id === emp.id)
        .reduce((sum, l) => sum + parseFloat(l.total_hours || 0), 0);
      const usedDays = (usedLeaveHours / 8).toFixed(1);
      const remainingDays = Math.max(0, totalDays - (usedLeaveHours / 8)).toFixed(1);

      return sanitizeEmployeeSensitiveData({
        ...emp,
        seniorityText,
        annualLeaveTotal: totalDays,
        annualLeaveUsed: parseFloat(usedDays),
        annualLeaveRemaining: parseFloat(remainingDays)
      }, isAuthorized);
    });

    const departments = deptResult.rows.map(dept => {
      return {
        ...dept,
        members: employeesWithSeniority.filter(emp => emp.department_id === dept.id)
      };
    });

    const unassigned = employeesWithSeniority.filter(emp => !emp.department_id);

    res.json({
      departments,
      unassigned,
      employees: employeesWithSeniority
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching departments' });
  }
});

app.get('/api/employees', async (req, res) => {
  const { requester_id } = req.query;
  try {
    let isAuthorized = false;
    if (requester_id) {
      const reqEmp = (await pool.query(`SELECT role FROM employees WHERE id = $1`, [requester_id])).rows[0];
      if (reqEmp && (reqEmp.role === 'admin' || reqEmp.role === 'hr')) isAuthorized = true;
    }

    const result = await pool.query(`
      SELECT e.id, e.employee_no, e.name, e.job_title, e.role, e.email, e.department_id, e.manager_id, e.hire_date,
             COALESCE(pgp_sym_decrypt(e.base_salary_encrypted, $1), '0') as base_salary,
             COALESCE(pgp_sym_decrypt(e.meal_allowance_encrypted, $1), '3000') as meal_allowance,
             COALESCE(pgp_sym_decrypt(e.transport_allowance_encrypted, $1), '0') as transport_allowance,
             COALESCE(pgp_sym_decrypt(e.performance_bonus_encrypted, $1), '0') as performance_bonus,
             COALESCE(pgp_sym_decrypt(e.festival_bonus_encrypted, $1), '0') as festival_bonus,
             e.fixed_allowance, e.labor_pension_self_rate, e.bank_code, e.bank_account,
             d.name as department_name, m.name as manager_name
      FROM employees e 
      LEFT JOIN departments d ON e.department_id = d.id 
      LEFT JOIN employees m ON e.manager_id = m.id
      ORDER BY e.employee_no ASC
    `, [DB_SECRET_KEY]);
    
    const leaves = (await pool.query(`SELECT * FROM leave_requests WHERE leave_type = 'annual' AND status = 'approved'`)).rows;

    const enriched = result.rows.map(emp => {
      const { seniorityText, totalDays } = calculateSeniorityAndLeave(emp.hire_date);
      const usedHours = leaves
        .filter(l => l.employee_id === emp.id)
        .reduce((sum, l) => sum + parseFloat(l.total_hours || 0), 0);
      const usedDays = parseFloat((usedHours / 8).toFixed(1));
      const remainingDays = Math.max(0, totalDays - usedDays);

      return sanitizeEmployeeSensitiveData({
        ...emp,
        seniorityText,
        annualLeaveTotal: totalDays,
        annualLeaveUsed: usedDays,
        annualLeaveRemaining: remainingDays
      }, isAuthorized);
    });

    res.json(enriched);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching employees' });
  }
});

app.put('/api/employees/:id', async (req, res) => {
  const { id } = req.params;
  const { 
    name, employee_no, job_title, role, department_id, hire_date,
    base_salary, fixed_allowance, meal_allowance, transport_allowance, 
    performance_bonus, festival_bonus, labor_pension_self_rate 
  } = req.body;

  try {
    const result = await pool.query(
      `UPDATE employees SET
        name = COALESCE($1, name),
        employee_no = COALESCE($2, employee_no),
        job_title = COALESCE($3, job_title),
        role = COALESCE($4, role),
        department_id = $5,
        hire_date = COALESCE($6, hire_date),
        base_salary_encrypted = pgp_sym_encrypt($7::text, $14),
        meal_allowance_encrypted = pgp_sym_encrypt($8::text, $14),
        transport_allowance_encrypted = pgp_sym_encrypt($9::text, $14),
        performance_bonus_encrypted = pgp_sym_encrypt($10::text, $14),
        festival_bonus_encrypted = pgp_sym_encrypt($11::text, $14),
        labor_pension_self_rate = COALESCE($12, labor_pension_self_rate),
        base_salary = NULL,
        meal_allowance = NULL,
        transport_allowance = NULL,
        performance_bonus = NULL,
        festival_bonus = NULL,
        updated_at = NOW()
       WHERE id = $13 RETURNING *`,
      [
        name, employee_no, job_title, role, department_id || null, hire_date,
        base_salary || '0', meal_allowance || '3000', transport_allowance || '0',
        performance_bonus || '0', festival_bonus || '0', labor_pension_self_rate || 6,
        DB_SECRET_KEY, id
      ]
    );
    res.json({ message: `員工 【${result.rows[0].name}】 薪資已以 AES-256 密碼學加密儲存，舊明文已徹底抹除！`, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating employee' });
  }
});

// ----------------------------------------------------
// 3. 打卡與請假 API (Phase 1 強化：勞基法46小時警示與完整假別)
// ----------------------------------------------------

app.get('/api/attendance', async (req, res) => {
  const { requester_id } = req.query;
  try {
    if (!requester_id) {
      const result = await pool.query(`
        SELECT a.*, e.name as employee_name, e.employee_no 
        FROM attendance_logs a JOIN employees e ON a.employee_id = e.id
        ORDER BY a.created_at DESC LIMIT 50
      `);
      return res.json(result.rows);
    }

    const reqEmp = (await pool.query(`SELECT * FROM employees WHERE id = $1`, [requester_id])).rows[0];
    if (!reqEmp) return res.json([]);

    let query = `
      SELECT a.*, e.name as employee_name, e.employee_no 
      FROM attendance_logs a 
      JOIN employees e ON a.employee_id = e.id
    `;
    const params = [];

    if (reqEmp.role === 'employee') {
      query += ` WHERE a.employee_id = $1`;
      params.push(requester_id);
    } else if (reqEmp.role === 'manager') {
      query += ` WHERE e.department_id = $1 OR a.employee_id = $2`;
      params.push(reqEmp.department_id, requester_id);
    }

    query += ` ORDER BY a.created_at DESC LIMIT 50`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching attendance' });
  }
});

app.post('/api/attendance/clock', async (req, res) => {
  const { employee_id, type, location, lat, lng, overtime_hours, overtime_type } = req.body;
  try {
    // 🌟 Phase 1 加班上限檢查：《勞基法》第32條每月不得超過46小時
    if (overtime_hours && parseFloat(overtime_hours) > 0) {
      const now = new Date();
      const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const sumRes = await pool.query(`
        SELECT COALESCE(SUM(overtime_hours), 0) as total_ot 
        FROM attendance_logs 
        WHERE employee_id = $1 AND created_at >= $2
      `, [employee_id, firstDayOfMonth]);

      const monthlyOT = parseFloat(sumRes.rows[0].total_ot) + parseFloat(overtime_hours);
      if (monthlyOT > 46.0) {
        return res.status(400).json({
          error: `⚠️ 觸發《勞基法》第32條警戒：當月累計加班時間為 ${monthlyOT.toFixed(1)} 小時，已超過法定上限 46 小時/月！已依法進行強制阻擋。`
        });
      }
    }

    const today = new Date().toISOString().split('T')[0];
    const existingLog = await pool.query(
      `SELECT * FROM attendance_logs 
       WHERE employee_id = $1 AND DATE(created_at) = $2 AND clock_out IS NULL 
       ORDER BY created_at DESC LIMIT 1`,
      [employee_id, today]
    );

    if (type === 'in') {
      const newLog = await pool.query(
        `INSERT INTO attendance_logs 
         (employee_id, clock_in, clock_in_location, clock_in_lat, clock_in_lng) 
         VALUES ($1, NOW(), $2, $3, $4) RETURNING *`,
        [employee_id, location || '台北辦公室 (GPS: 25.0330, 121.5654)', lat || 25.0330, lng || 121.5654]
      );
      return res.json({ message: '上班打卡成功！', data: newLog.rows[0] });
    } else if (type === 'out') {
      if (existingLog.rows.length === 0) {
        const newLog = await pool.query(
          `INSERT INTO attendance_logs 
           (employee_id, clock_out, clock_in_location, overtime_hours, overtime_type) 
           VALUES ($1, NOW(), $2, $3, $4)`,
          [employee_id, location || '台北辦公室 (下班)', overtime_hours || 0, overtime_type || 'workday']
        );
        return res.json({ message: '下班打卡成功！', data: newLog.rows[0] });
      } else {
        const logId = existingLog.rows[0].id;
        const updatedLog = await pool.query(
          `UPDATE attendance_logs SET clock_out = NOW(), overtime_hours = $1, overtime_type = $2 WHERE id = $3 RETURNING *`,
          [overtime_hours || 0, overtime_type || 'workday', logId]
        );
        return res.json({ message: '下班打卡成功！', data: updatedLog.rows[0] });
      }
    } else {
      return res.status(400).json({ error: 'Invalid clock type' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error processing clock-in/out' });
  }
});

app.get('/api/leave', async (req, res) => {
  const { requester_id } = req.query;
  try {
    let baseQuery = `
      SELECT l.*, e.name as employee_name, e.employee_no, d.name as department_name,
             m.name as manager_reviewer_name, a.name as adm_reviewer_name, c.name as ceo_reviewer_name
      FROM leave_requests l
      JOIN employees e ON l.employee_id = e.id
      LEFT JOIN departments d ON e.department_id = d.id
      LEFT JOIN employees m ON l.manager_approved_by = m.id
      LEFT JOIN employees a ON l.adm_approved_by = a.id
      LEFT JOIN employees c ON l.ceo_approved_by = c.id
    `;

    if (!requester_id) {
      const result = await pool.query(baseQuery + ` ORDER BY l.created_at DESC`);
      return res.json(result.rows);
    }

    const reqEmp = (await pool.query(`SELECT e.*, d.code as dept_code FROM employees e LEFT JOIN departments d ON e.department_id = d.id WHERE e.id = $1`, [requester_id])).rows[0];
    if (!reqEmp) return res.json([]);

    const params = [];
    let condition = '';

    if (reqEmp.role === 'employee') {
      params.push(requester_id);
      condition = ` WHERE l.employee_id = $1`;
    } else if (reqEmp.role === 'manager') {
      if (reqEmp.dept_code === 'ADM') {
        params.push(requester_id);
        condition = ` WHERE l.employee_id = $1 OR l.current_stage = 'adm' OR l.status = 'pending_adm' OR e.department_id = '${reqEmp.department_id}'`;
      } else {
        params.push(requester_id, reqEmp.department_id);
        condition = ` WHERE l.employee_id = $1 OR e.department_id = $2`;
      }
    }

    const result = await pool.query(baseQuery + condition + ` ORDER BY l.created_at DESC`, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching leave requests' });
  }
});

app.post('/api/leave', async (req, res) => {
  const { employee_id, leave_type, start_time, end_time, total_hours, reason } = req.body;
  try {
    const leaveDays = parseFloat((parseFloat(total_hours || 8) / 8).toFixed(1));
    
    const empRes = await pool.query(`SELECT e.*, d.code as dept_code, d.name as dept_name FROM employees e LEFT JOIN departments d ON e.department_id = d.id WHERE e.id = $1`, [employee_id]);
    const emp = empRes.rows[0];

    // 生理假特殊限制檢核：《性別平等工作法》第14條每月1天
    if (leave_type === 'menstrual') {
      const now = new Date();
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const menstrualCheck = await pool.query(`
        SELECT COUNT(*)::int as count FROM leave_requests 
        WHERE employee_id = $1 AND leave_type = 'menstrual' AND created_at >= $2 AND status != 'rejected'
      `, [employee_id, firstDay]);
      if (menstrualCheck.rows[0].count >= 1) {
        return res.status(400).json({ error: '⚠️ 依《性別平等工作法》規定，生理假每月以 1 日為限。本月已有申請紀錄！' });
      }
    }

    let targetManagerId = emp.manager_id;
    if (!targetManagerId && emp.department_id) {
      const deptMgrRes = await pool.query(`
        SELECT id, name FROM employees 
        WHERE department_id = $1 AND role = 'manager' AND id != $2 
        LIMIT 1
      `, [emp.department_id, employee_id]);
      if (deptMgrRes.rows.length > 0) {
        targetManagerId = deptMgrRes.rows[0].id;
      }
    }

    let initialStage = 'manager';
    let initialStatus = 'pending_manager';
    if (emp.role === 'manager') {
      initialStage = 'adm';
      initialStatus = 'pending_adm';
    }

    const result = await pool.query(
      `INSERT INTO leave_requests 
       (employee_id, leave_type, start_time, end_time, total_hours, reason, status, current_stage) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [employee_id, leave_type, start_time, end_time, total_hours || 8, reason, initialStatus, initialStage]
    );

    const leaveRequest = result.rows[0];

    let targetManagerName = '部門主管';
    if (targetManagerId) {
      const mgrNameRes = await pool.query(`SELECT name FROM employees WHERE id = $1`, [targetManagerId]);
      if (mgrNameRes.rows.length > 0) targetManagerName = mgrNameRes.rows[0].name;

      await pool.query(
        `INSERT INTO notifications (recipient_id, title, message, link) VALUES ($1, $2, $3, $4)`,
        [
          targetManagerId,
          `📬 待簽核請假申請：${emp.name}`,
          `組員 ${emp.name} 申請了 ${leaveDays} 天 (${total_hours}小時) ${leave_type}，請進行一級部門主管審核。`,
          '#leave'
        ]
      );
    }

    res.json({
      message: `請假申請已送出！一級簽核呈報至【${emp.dept_name || '同部門'} 主管：${targetManagerName}】。`,
      data: leaveRequest,
      leaveDays
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error submitting leave request' });
  }
});

app.put('/api/leave/:id/review', async (req, res) => {
  const { id } = req.params;
  const { reviewer_id, status, comment } = req.body;
  try {
    const leaveRes = await pool.query(`
      SELECT l.*, e.name as emp_name, e.department_id, d.name as dept_name, d.code as dept_code 
      FROM leave_requests l 
      JOIN employees e ON l.employee_id = e.id 
      LEFT JOIN departments d ON e.department_id = d.id
      WHERE l.id = $1
    `, [id]);
    if (leaveRes.rows.length === 0) return res.status(404).json({ error: 'Leave request not found' });

    const leave = leaveRes.rows[0];
    const leaveDays = parseFloat((parseFloat(leave.total_hours) / 8).toFixed(1));

    const reviewerRes = await pool.query(`SELECT e.*, d.code as dept_code FROM employees e LEFT JOIN departments d ON e.department_id = d.id WHERE e.id = $1`, [reviewer_id]);
    if (reviewerRes.rows.length === 0) return res.status(403).json({ error: '無效的簽核人員' });
    const reviewer = reviewerRes.rows[0];

    if (reviewer.role !== 'admin') {
      if (leave.current_stage === 'manager' && reviewer.department_id !== leave.department_id && reviewer.role !== 'manager') {
        return res.status(403).json({ error: '❌ 越權存取：您非該員工所屬部門的主管，無權簽核此假單！' });
      }
      if (leave.current_stage === 'adm' && reviewer.dept_code !== 'ADM') {
        return res.status(403).json({ error: '❌ 越權存取：此假單已呈報至總經理室，需由總經理二審！' });
      }
      if (leave.current_stage === 'ceo' && reviewer.role !== 'admin') {
        return res.status(403).json({ error: '❌ 越權存取：此假單需由 CEO 最高管理者進行三級終審！' });
      }
    }

    if (status === 'rejected') {
      await pool.query(
        `UPDATE leave_requests SET status = 'rejected', reviewer_id = $1, reviewer_comment = $2, reviewed_at = NOW() WHERE id = $3`,
        [reviewer_id, comment || '駁回申請', id]
      );
      await pool.query(
        `INSERT INTO notifications (recipient_id, title, message) VALUES ($1, $2, $3)`,
        [leave.employee_id, `❌ 請假申請已被駁回`, `您申請的 ${leaveDays} 天請假已被駁回，原因：${comment || '無'}`]
      );
      return res.json({ message: '假單已駁回！' });
    }

    if (leave.current_stage === 'manager') {
      if (leaveDays <= 1.0) {
        await pool.query(
          `UPDATE leave_requests SET status = 'approved', manager_approved_by = $1, manager_approved_at = NOW(), reviewer_id = $1, reviewed_at = NOW() WHERE id = $2`,
          [reviewer_id, id]
        );
        await pool.query(
          `INSERT INTO notifications (recipient_id, title, message) VALUES ($1, $2, $3)`,
          [leave.employee_id, `🎉 請假核准通知`, `您申請的 ${leaveDays} 天假單 (≤1天) 已由部門主管簽核完成，全數結案！`]
        );
        return res.json({ message: '部門主管一級簽核完成，假單已核准結案！' });
      } else {
        await pool.query(
          `UPDATE leave_requests SET status = 'pending_adm', current_stage = 'adm', manager_approved_by = $1, manager_approved_at = NOW() WHERE id = $2`,
          [reviewer_id, id]
        );

        const admMgrRes = await pool.query(`SELECT e.id FROM employees e JOIN departments d ON e.department_id = d.id WHERE d.code = 'ADM' AND e.role = 'manager' LIMIT 1`);
        const admMgrId = admMgrRes.rows.length > 0 ? admMgrRes.rows[0].id : reviewer_id;

        await pool.query(
          `INSERT INTO notifications (recipient_id, title, message, link) VALUES ($1, $2, $3, $4)`,
          [
            admMgrId,
            `🚨【二級簽核呈報】待總經理審核`,
            `員工 ${leave.emp_name} (${leave.dept_name}) 請假 ${leaveDays} 天 (>1天)，部門主管已初審，現呈報至總經理室請您審核。`,
            '#leave'
          ]
        );
        return res.json({ message: '部門主管一審通過！因假單 > 1 天，已向上呈報至【總經理室】二審。' });
      }
    } else if (leave.current_stage === 'adm') {
      if (leaveDays <= 3.0) {
        await pool.query(
          `UPDATE leave_requests SET status = 'approved', adm_approved_by = $1, adm_approved_at = NOW(), reviewer_id = $1, reviewed_at = NOW() WHERE id = $2`,
          [reviewer_id, id]
        );
        await pool.query(
          `INSERT INTO notifications (recipient_id, title, message) VALUES ($1, $2, $3)`,
          [leave.employee_id, `🎉【二級簽核完成】請假核准`, `您申請的 ${leaveDays} 天假單 (≤3天) 已通過部門主管與總經理室二審，全數結案！`]
        );
        return res.json({ message: '總經理二級簽核完成，假單已核准結案！' });
      } else {
        await pool.query(
          `UPDATE leave_requests SET status = 'pending_ceo', current_stage = 'ceo', adm_approved_by = $1, adm_approved_at = NOW() WHERE id = $2`,
          [reviewer_id, id]
        );

        const ceoRes = await pool.query(`SELECT id FROM employees WHERE role = 'admin' LIMIT 1`);
        const ceoId = ceoRes.rows.length > 0 ? ceoRes.rows[0].id : reviewer_id;

        await pool.query(
          `INSERT INTO notifications (recipient_id, title, message, link) VALUES ($1, $2, $3, $4)`,
          [
            ceoId,
            `👑【三級長假終審】待 CEO 審核`,
            `員工 ${leave.emp_name} 申請 ${leaveDays} 天長假 (>3天)，已通過部門主管與總經理審核，請 CEO 進行三級終審。`,
            '#leave'
          ]
        );
        return res.json({ message: '總經理二審通過！因請假 > 3 天，已呈報至【CEO】三級終審。' });
      }
    } else if (leave.current_stage === 'ceo') {
      await pool.query(
        `UPDATE leave_requests SET status = 'approved', ceo_approved_by = $1, ceo_approved_at = NOW(), reviewer_id = $1, reviewed_at = NOW() WHERE id = $2`,
        [reviewer_id, id]
      );
      await pool.query(
        `INSERT INTO notifications (recipient_id, title, message) VALUES ($1, $2, $3)`,
        [leave.employee_id, `👑【三級終審通過】長假核准`, `您申請的 ${leaveDays} 天長假已通過部門主管、總經理與 CEO 三級終審！`]
      );
      return res.json({ message: 'CEO 三級終審完成，假單全數核准結案！' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error reviewing leave request' });
  }
});

// ----------------------------------------------------
// 4. 簽核天數層級規則與通知 API
// ----------------------------------------------------

app.get('/api/approval-levels', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM approval_levels ORDER BY min_days ASC`);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching approval levels' });
  }
});

app.put('/api/approval-levels', async (req, res) => {
  const { levels } = req.body;
  try {
    for (const lvl of levels) {
      await pool.query(
        `UPDATE approval_levels SET min_days = $1, max_days = $2, description = $3 WHERE id = $4`,
        [lvl.min_days, lvl.max_days, lvl.description, lvl.id]
      );
    }
    res.json({ message: '簽核層級天數規則已成功更新！' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating approval levels' });
  }
});

app.get('/api/notifications', async (req, res) => {
  const { recipient_id } = req.query;
  try {
    let query = `SELECT * FROM notifications`;
    const params = [];
    if (recipient_id) {
      query += ` WHERE recipient_id = $1`;
      params.push(recipient_id);
    }
    query += ` ORDER BY created_at DESC LIMIT 20`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching notifications' });
  }
});

app.put('/api/notifications/:id/read', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(`UPDATE notifications SET is_read = TRUE WHERE id = $1`, [id]);
    res.json({ message: 'Marked as read' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ----------------------------------------------------
// 5. 100% 台灣薪資與加班費分流引擎 (Phase 1 強化)
// ----------------------------------------------------

function calculateTaiwanPayrollFull(employee, monthLeaves = [], monthOTLogs = []) {
  const baseSalary = parseFloat(employee.base_salary || 0);
  const fixedAllowance = parseFloat(employee.fixed_allowance || 0);
  const mealAllowance = parseFloat(employee.meal_allowance || 3000);
  const transportAllowance = parseFloat(employee.transport_allowance || 0);
  const performanceBonus = parseFloat(employee.performance_bonus || 0);
  const festivalBonus = parseFloat(employee.festival_bonus || 0);

  const laborInsuranceGrade = parseFloat(employee.labor_insurance_grade || baseSalary);
  const healthInsuranceGrade = parseFloat(employee.health_insurance_grade || baseSalary);
  const dependentsCount = parseInt(employee.dependents_count || 0, 10);
  const pensionSelfRate = parseFloat(employee.labor_pension_self_rate !== undefined ? employee.labor_pension_self_rate : 6);

  const hourlyRate = baseSalary / 240;

  // 🌟 Phase 1 加班費倍率精準分流 (平日 / 休息日 / 國定假日 / 例假日)
  let totalOTPay = 0;
  monthOTLogs.forEach(log => {
    const hours = parseFloat(log.overtime_hours || 0);
    const type = log.overtime_type || 'workday';
    
    if (type === 'workday') {
      if (hours <= 2) totalOTPay += hours * hourlyRate * 1.34;
      else totalOTPay += (2 * hourlyRate * 1.34) + ((hours - 2) * hourlyRate * 1.67);
    } else if (type === 'rest_day') {
      if (hours <= 2) totalOTPay += hours * hourlyRate * 1.34;
      else if (hours <= 8) totalOTPay += (2 * hourlyRate * 1.34) + ((hours - 2) * hourlyRate * 1.67);
      else totalOTPay += (2 * hourlyRate * 1.34) + (6 * hourlyRate * 1.67) + ((hours - 8) * hourlyRate * 2.67);
    } else if (type === 'national_holiday') {
      if (hours <= 8) totalOTPay += 8 * hourlyRate * 1.0;
      else totalOTPay += (8 * hourlyRate * 1.0) + ((hours - 8) * hourlyRate * 1.67);
    }
  });
  const overtimePay = Math.round(totalOTPay);

  // 🌟 Phase 1 精準假別扣薪演算法符合《勞工請假規則》
  let leaveDeduction = 0;
  monthLeaves.forEach(l => {
    if (l.status === 'approved') {
      const hours = parseFloat(l.total_hours || 0);
      if (l.leave_type === 'sick' || l.leave_type === 'menstrual') {
        leaveDeduction += hours * hourlyRate * 0.5; // 病假與生理假半薪
      } else if (l.leave_type === 'personal' || l.leave_type === 'family_care') {
        leaveDeduction += hours * hourlyRate * 1.0; // 事假與家庭照顧假不給薪
      }
      // 特休、婚假、喪假、產假、陪產假、產檢假、公傷假均為全薪，不扣款！
    }
  });
  leaveDeduction = Math.round(leaveDeduction);

  const totalAllowancesAndBonuses = fixedAllowance + mealAllowance + transportAllowance + performanceBonus + festivalBonus;
  const grossSalary = Math.max(0, Math.round(baseSalary + totalAllowancesAndBonuses + overtimePay - leaveDeduction));

  const laborInsuranceEmployee = Math.round(laborInsuranceGrade * 0.11 * 0.20);
  const laborInsuranceEmployer = Math.round(laborInsuranceGrade * 0.11 * 0.70);

  const cappedDependents = Math.min(dependentsCount, 3);
  const healthInsuranceEmployee = Math.round(healthInsuranceGrade * 0.0517 * 0.30 * (1 + cappedDependents));
  const healthInsuranceEmployer = Math.round(healthInsuranceGrade * 0.0517 * 0.60 * 1.57);

  const laborPensionEmployer6Pct = Math.round(baseSalary * 0.06);
  const laborPensionEmployeeSelf = Math.round(baseSalary * (pensionSelfRate / 100));

  const diffSalary = Math.max(0, grossSalary - healthInsuranceGrade);
  const employerSecondNHI = Math.round(diffSalary * 0.0211);

  const taxExemptMeal = Math.min(3000, mealAllowance);
  const taxableGross = Math.max(0, grossSalary - taxExemptMeal);
  const taxableIncome = Math.max(0, taxableGross - laborPensionEmployeeSelf);
  const withholdingTax = taxableIncome > 88501 ? Math.round(taxableIncome * 0.05) : 0;

  const totalDeductions = laborInsuranceEmployee + healthInsuranceEmployee + laborPensionEmployeeSelf + withholdingTax;
  const netSalary = Math.max(0, grossSalary - totalDeductions);

  const employerTotalCost = grossSalary + laborInsuranceEmployer + healthInsuranceEmployer + laborPensionEmployer6Pct + employerSecondNHI;

  const { seniorityText, totalDays } = calculateSeniorityAndLeave(employee.hire_date);

  return {
    employee_id: employee.id,
    employee_no: employee.employee_no,
    employee_name: employee.name,
    job_title: employee.job_title,
    hire_date: employee.hire_date ? new Date(employee.hire_date).toISOString().split('T')[0] : '未設定',
    seniorityText,
    annualLeaveTotal: totalDays,
    bank_code: employee.bank_code || '812',
    bank_account: employee.bank_account || '123456789012',
    base_salary: baseSalary,
    fixed_allowance: fixedAllowance,
    meal_allowance: mealAllowance,
    transport_allowance: transportAllowance,
    performance_bonus: performanceBonus,
    festival_bonus: festivalBonus,
    total_allowances_and_bonuses: totalAllowancesAndBonuses,
    overtime_pay: overtimePay,
    leave_deduction: leaveDeduction,
    gross_salary: grossSalary,
    labor_insurance_employee: laborInsuranceEmployee,
    health_insurance_employee: healthInsuranceEmployee,
    labor_pension_self_rate: pensionSelfRate,
    labor_pension_employee_self: laborPensionEmployeeSelf,
    withholding_tax: withholdingTax,
    total_deductions: totalDeductions,
    net_salary: netSalary,
    labor_insurance_employer: laborInsuranceEmployer,
    health_insurance_employer: healthInsuranceEmployer,
    labor_pension_employer_6pct: laborPensionEmployer6Pct,
    employer_second_nhi: employerSecondNHI,
    employer_total_cost: employerTotalCost
  };
}

app.get('/api/payroll/calculate', async (req, res) => {
  const { month, requester_id } = req.query;
  try {
    if (requester_id) {
      const reqEmp = (await pool.query(`SELECT role FROM employees WHERE id = $1`, [requester_id])).rows[0];
      if (!reqEmp || (reqEmp.role !== 'admin' && reqEmp.role !== 'hr')) {
        return res.status(403).json({ error: '🔒 存取拒絕：您無存取全公司薪資與發薪模組之權限！' });
      }
    }

    const employees = (await pool.query(`
      SELECT e.id, e.employee_no, e.name, e.job_title, e.role, e.email, e.department_id, e.hire_date,
             COALESCE(pgp_sym_decrypt(e.base_salary_encrypted, $1), '0') as base_salary,
             COALESCE(pgp_sym_decrypt(e.meal_allowance_encrypted, $1), '3000') as meal_allowance,
             COALESCE(pgp_sym_decrypt(e.transport_allowance_encrypted, $1), '0') as transport_allowance,
             COALESCE(pgp_sym_decrypt(e.performance_bonus_encrypted, $1), '0') as performance_bonus,
             COALESCE(pgp_sym_decrypt(e.festival_bonus_encrypted, $1), '0') as festival_bonus,
             e.fixed_allowance, e.labor_pension_self_rate, e.bank_code, e.bank_account
      FROM employees e 
      WHERE e.is_active = TRUE 
      ORDER BY e.employee_no ASC
    `, [DB_SECRET_KEY])).rows;

    const leaves = (await pool.query(`SELECT * FROM leave_requests WHERE status = 'approved'`)).rows;
    const attendanceLogs = (await pool.query(`SELECT * FROM attendance_logs WHERE overtime_hours > 0`)).rows;

    const payrollDetails = employees.map(emp => {
      const empLeaves = leaves.filter(l => l.employee_id === emp.id);
      const empOTLogs = attendanceLogs.filter(a => a.employee_id === emp.id);
      return calculateTaiwanPayrollFull(emp, empLeaves, empOTLogs);
    });

    const summary = payrollDetails.reduce((acc, curr) => {
      acc.total_gross += curr.gross_salary;
      acc.total_net += curr.net_salary;
      acc.total_employee_deductions += curr.total_deductions;
      acc.total_pension_employer += curr.labor_pension_employer_6pct;
      acc.total_pension_self += curr.labor_pension_employee_self;
      acc.total_employer_cost += curr.employer_total_cost;
      return acc;
    }, { total_gross: 0, total_net: 0, total_employee_deductions: 0, total_pension_employer: 0, total_pension_self: 0, total_employer_cost: 0 });

    res.json({
      month: month || '2026-07',
      summary,
      details: payrollDetails
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error calculating payroll' });
  }
});

app.get('/api/export/bank-transfer', async (req, res) => {
  const { month } = req.query;
  try {
    const employees = (await pool.query(`
      SELECT e.id, e.employee_no, e.name, e.job_title, e.role, e.email, e.department_id, e.hire_date,
             COALESCE(pgp_sym_decrypt(e.base_salary_encrypted, $1), '0') as base_salary,
             COALESCE(pgp_sym_decrypt(e.meal_allowance_encrypted, $1), '3000') as meal_allowance,
             COALESCE(pgp_sym_decrypt(e.transport_allowance_encrypted, $1), '0') as transport_allowance,
             COALESCE(pgp_sym_decrypt(e.performance_bonus_encrypted, $1), '0') as performance_bonus,
             COALESCE(pgp_sym_decrypt(e.festival_bonus_encrypted, $1), '0') as festival_bonus,
             e.fixed_allowance, e.labor_pension_self_rate, e.bank_code, e.bank_account
      FROM employees e 
      WHERE e.is_active = TRUE 
      ORDER BY e.employee_no ASC
    `, [DB_SECRET_KEY])).rows;

    const leaves = (await pool.query(`SELECT * FROM leave_requests WHERE status = 'approved'`)).rows;
    const attendanceLogs = (await pool.query(`SELECT * FROM attendance_logs WHERE overtime_hours > 0`)).rows;

    const payrollDetails = employees.map(emp => {
      const empLeaves = leaves.filter(l => l.employee_id === emp.id);
      const empOTLogs = attendanceLogs.filter(a => a.employee_id === emp.id);
      return calculateTaiwanPayrollFull(emp, empLeaves, empOTLogs);
    });

    let csv = '\uFEFF項次,員工編號,員工姓名,銀行代碼,轉帳帳號,實發金額(NT$),轉帳備註\n';
    payrollDetails.forEach((item, index) => {
      csv += `${index + 1},"${item.employee_no}","${item.employee_name}","${item.bank_code}","${item.bank_account}",${item.net_salary},"${month || '2026-07'} 薪資發放"\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Bank_Transfer_${month || '2026-07'}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error exporting bank transfer file' });
  }
});

app.get('/api/export/pay-slip', async (req, res) => {
  const { employee_id, month } = req.query;
  try {
    const empResult = await pool.query(`
      SELECT e.id, e.employee_no, e.name, e.job_title, e.role, e.email, e.department_id, e.hire_date,
             COALESCE(pgp_sym_decrypt(e.base_salary_encrypted, $1), '0') as base_salary,
             COALESCE(pgp_sym_decrypt(e.meal_allowance_encrypted, $1), '3000') as meal_allowance,
             COALESCE(pgp_sym_decrypt(e.transport_allowance_encrypted, $1), '0') as transport_allowance,
             COALESCE(pgp_sym_decrypt(e.performance_bonus_encrypted, $1), '0') as performance_bonus,
             COALESCE(pgp_sym_decrypt(e.festival_bonus_encrypted, $1), '0') as festival_bonus,
             e.fixed_allowance, e.labor_pension_self_rate, e.bank_code, e.bank_account
      FROM employees e 
      WHERE e.id = $2
    `, [DB_SECRET_KEY, employee_id]);
    if (empResult.rows.length === 0) return res.status(404).send('Employee not found');

    const employee = empResult.rows[0];
    const leaves = (await pool.query(`SELECT * FROM leave_requests WHERE employee_id = $1 AND status = 'approved'`, [employee_id])).rows;
    const attendanceLogs = (await pool.query(`SELECT * FROM attendance_logs WHERE employee_id = $1 AND overtime_hours > 0`, [employee_id])).rows;
    const item = calculateTaiwanPayrollFull(employee, leaves, attendanceLogs);

    const html = `
    <!DOCTYPE html>
    <html lang="zh-TW">
    <head>
      <meta charset="UTF-8">
      <title>${month || '2026-07'} 薪資明細單 - ${item.employee_name}</title>
      <style>
        body { font-family: sans-serif; background: #f8fafc; padding: 20px; color: #1e293b; }
        .slip-box { max-width: 750px; margin: 0 auto; background: #fff; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); border: 1px solid #cbd5e1; }
        h2 { text-align: center; color: #0f172a; margin-bottom: 5px; }
        .sub-header { text-align: center; color: #64748b; font-size: 13px; margin-bottom: 20px; }
        .info-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; background: #f1f5f9; padding: 12px; border-radius: 8px; font-size: 13px; margin-bottom: 20px; }
        table { border-collapse: collapse; width: 100%; margin-bottom: 20px; font-size: 13px; }
        th, td { border: 1px solid #cbd5e1; padding: 8px 10px; text-align: left; }
        th { background: #e2e8f0; font-weight: bold; }
        .section-title { background: #f8fafc; font-weight: bold; color: #334155; }
        .total-row { font-weight: bold; background: #f1f5f9; }
        .net-box { text-align: right; background: #ecfdf5; border: 2px solid #10b981; padding: 15px; border-radius: 8px; color: #047857; font-size: 18px; font-weight: bold; }
        .pension-badge { display: inline-block; background: #dbeafe; color: #1e40af; font-size: 11px; padding: 2px 6px; border-radius: 4px; font-weight: bold; }
        .footer { text-align: center; font-size: 11px; color: #94a3b8; margin-top: 25px; }
      </style>
    </head>
    <body>
      <div class="slip-box">
        <h2>貴公司 正式薪資與福利明細單 (Phase 1 勞基法全假別合規)</h2>
        <div class="sub-header">計薪月份：${month || '2026-07'} | 機密薪資文件 妥善保管</div>
        
        <div class="info-grid">
          <div><strong>員工編號：</strong> ${item.employee_no}</div>
          <div><strong>員工姓名：</strong> ${item.employee_name}</div>
          <div><strong>職稱：</strong> ${item.job_title || '專員'}</div>
          <div><strong>到職日期：</strong> ${item.hire_date}</div>
          <div><strong>服務年資：</strong> ${item.seniorityText}</div>
          <div><strong>勞基特休天數：</strong> ${item.annualLeaveTotal} 天/年</div>
        </div>

        <table>
          <thead>
            <tr><th>應發薪資與自訂補助/獎金</th><th>金額 (NT$)</th><th>員工扣繳項目</th><th>金額 (NT$)</th></tr>
          </thead>
          <tbody>
            <tr><td>約定底薪 (Base Salary)</td><td>${item.base_salary.toLocaleString()}</td><td>勞保費自付額 (20%)</td><td>${item.labor_insurance_employee.toLocaleString()}</td></tr>
            <tr><td>固定津貼 (Fixed Allowance)</td><td>${item.fixed_allowance.toLocaleString()}</td><td>健保費自付額 (30%)</td><td>${item.health_insurance_employee.toLocaleString()}</td></tr>
            <tr><td>🍱 伙食補助 (免稅額 $3,000)</td><td>${item.meal_allowance.toLocaleString()}</td><td>🌟 勞退個人自提 (${item.labor_pension_self_rate}%) <span class="pension-badge">免稅</span></td><td>${item.labor_pension_employee_self.toLocaleString()}</td></tr>
            <tr><td>🚗 交通補助 (Transport)</td><td>${item.transport_allowance.toLocaleString()}</td><td>預扣所得稅 (5%)</td><td>${item.withholding_tax.toLocaleString()}</td></tr>
            <tr><td>🎯 績效獎金 (Performance)</td><td>${item.performance_bonus.toLocaleString()}</td><td style="background:#f8fafc;" colspan="2"></td></tr>
            <tr><td>🎁 三節禮金 (Festival Bonus)</td><td>${item.festival_bonus.toLocaleString()}</td><td style="background:#f8fafc;" colspan="2"></td></tr>
            <tr><td>平日/休息日加班費</td><td>${item.overtime_pay.toLocaleString()}</td><td style="background:#f8fafc;" colspan="2"></td></tr>
            <tr><td>請假扣款 (病假/生理假半薪、事假全扣)</td><td>-${item.leave_deduction.toLocaleString()}</td><td style="background:#f8fafc;" colspan="2"></td></tr>
            <tr class="total-row">
              <td>應發總額 (Gross Pay)</td><td>NT$ ${item.gross_salary.toLocaleString()}</td>
              <td>扣繳小計 (Deductions)</td><td>NT$ ${item.total_deductions.toLocaleString()}</td>
            </tr>
          </tbody>
        </table>

        <table>
          <thead>
            <tr><th colspan="2" class="section-title">🏢 雇主依法負擔與團體福利 (公司負擔，不扣員工薪資)</th></tr>
          </thead>
          <tbody>
            <tr><td>🌟 勞工退休金 (新制) 雇主強制提繳 6% (專戶)</td><td style="color:#2563eb; font-weight:bold;">NT$ ${item.labor_pension_employer_6pct.toLocaleString()}</td></tr>
            <tr><td>勞工保險 雇主負擔額 (70% + 職災保險)</td><td>NT$ ${item.labor_insurance_employer.toLocaleString()}</td></tr>
            <tr><td>全民健保 雇主負擔額 (60% * 1.57)</td><td>NT$ ${item.health_insurance_employer.toLocaleString()}</td></tr>
            <tr><td>二代健保 雇主補充保費 (2.11%)</td><td>NT$ ${item.employer_second_nhi.toLocaleString()}</td></tr>
            <tr class="total-row">
              <td>雇主總人力負擔成本 (Employer Total Cost)</td><td style="color:#7c3aed; font-weight:bold;">NT$ ${item.employer_total_cost.toLocaleString()}</td>
            </tr>
          </tbody>
        </table>

        <div class="net-box">
          實發金額 (Net Salary): NT$ ${item.net_salary.toLocaleString()} 元
        </div>

        <div class="footer">
          依據《勞動基準法》第 23 條及第 38 條規定開立 | 伙食補助在 3,000 元內免列入薪資所得課稅
        </div>
      </div>
    </body>
    </html>
    `;
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error generating pay slip');
  }
});

app.post('/api/payroll/confirm', async (req, res) => {
  const { month, details } = req.body;
  try {
    for (const item of details) {
      await pool.query(
        `INSERT INTO payroll_records (
          employee_id, payroll_month,
          base_salary_encrypted, allowances_encrypted, overtime_pay_encrypted,
          gross_salary_encrypted, total_deductions_encrypted, net_salary_encrypted,
          labor_insurance_employee, health_insurance_employee, labor_pension_self, withholding_tax,
          labor_insurance_employer, health_insurance_employer, labor_pension_employer, status, paid_at
        ) VALUES (
          $1, $2,
          pgp_sym_encrypt($3::text, $9), pgp_sym_encrypt($4::text, $9), pgp_sym_encrypt($5::text, $9),
          pgp_sym_encrypt($6::text, $9), pgp_sym_encrypt($7::text, $9), pgp_sym_encrypt($8::text, $9),
          $10, $11, $12, $13, $14, $15, $16, 'approved', NOW()
        )`,
        [
          item.employee_id, month || '2026-07',
          item.base_salary.toString(), item.total_allowances_and_bonuses.toString(), item.overtime_pay.toString(),
          item.gross_salary.toString(), item.total_deductions.toString(), item.net_salary.toString(),
          DB_SECRET_KEY,
          item.labor_insurance_employee, item.health_insurance_employee, item.labor_pension_employee_self, item.withholding_tax,
          item.labor_insurance_employer, item.health_insurance_employer, item.labor_pension_employer_6pct
        ]
      );
    }
    res.json({ message: `【${month || '2026-07'}】薪資結算成功並完成 Phase 1 勞基法分流封存存檔！` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error confirming payroll' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 HRMS 本地 API 伺服器已啟動: http://localhost:${PORT}`);
});
