// Routes contributed by feature batches (daily workflows, follow-up, reports, migration).
// position: 'top' (after home), default (after directory), 'admin' (before health).
// `hidden` routes are reachable by link only (e.g. a student's profile) but still permission-gated.
import { renderDashboard } from './dashboard.js';
import { renderGate } from './gate.js';
import { renderRollcall } from './rollcall.js';
import { renderLeave } from './leave.js';
import { renderApprovals } from './approvals.js';
import { renderProfile } from './profile.js';

export const EXTRA_ROUTES = [
  { path: 'dashboard', position: 'top', title_th: 'ภาพรวมวันนี้', icon: '📊', anyOf: ['attendance.read'], render: renderDashboard },
  { path: 'gate', position: 'top', title_th: 'ลงเวลาหน้าประตู', icon: '🚪', anyOf: ['attendance.record'], render: renderGate },
  { path: 'rollcall', position: 'top', title_th: 'เช็กชื่อประจำวัน', icon: '✅', anyOf: ['attendance.rollcall'], render: renderRollcall },
  { path: 'leave', title_th: 'แจ้งลา', icon: '📝', anyOf: ['leave.submit', 'leave.read'], render: renderLeave },
  { path: 'approvals', title_th: 'พิจารณาใบลา', icon: '📋', anyOf: ['leave.approve', 'leave.confirm_guardian'], render: renderApprovals },
  { path: 'profile', hidden: true, title_th: 'ประวัตินักเรียน', icon: '👤', anyOf: ['student.read', 'student.read_basic'], render: renderProfile },
];
