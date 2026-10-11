// Routes contributed by feature batches (daily workflows, follow-up, reports, migration).
// position: 'top' (after home), default (after directory), 'admin' (before health).
// `hidden` routes are reachable by link only (e.g. a student's profile) but still permission-gated.
import { renderDashboard } from './dashboard.js';
import { renderGate } from './gate.js';
import { renderRollcall } from './rollcall.js';
import { renderLeave } from './leave.js';
import { renderApprovals } from './approvals.js';
import { renderProfile } from './profile.js';
import { renderCases } from './cases.js';
import { renderNotifications, renderLineLink, renderNotifyMonitor } from './notifications.js';
import { renderReports } from './reports.js';

export const EXTRA_ROUTES = [
  { path: 'dashboard', position: 'top', title_th: 'ภาพรวมวันนี้', icon: '📊', anyOf: ['attendance.read'], render: renderDashboard },
  { path: 'gate', position: 'top', title_th: 'ลงเวลาหน้าประตู', icon: '🚪', anyOf: ['attendance.record'], render: renderGate },
  { path: 'rollcall', position: 'top', title_th: 'เช็กชื่อประจำวัน', icon: '✅', anyOf: ['attendance.rollcall'], render: renderRollcall },
  { path: 'leave', title_th: 'แจ้งลา', icon: '📝', anyOf: ['leave.submit', 'leave.read'], render: renderLeave },
  { path: 'approvals', title_th: 'พิจารณาใบลา', icon: '📋', anyOf: ['leave.approve', 'leave.confirm_guardian'], render: renderApprovals },
  { path: 'notifications', position: 'top', title_th: 'การแจ้งเตือน', icon: '🔔', anyOf: ['notification.read_own'], render: renderNotifications },
  { path: 'cases', title_th: 'งานติดตามและการติดต่อ', icon: '📞', anyOf: ['case.read', 'case.record_contact'], render: renderCases },
  { path: 'reports', title_th: 'รายงาน', icon: '📈', anyOf: ['report.view', 'notification.monitor', 'audit.read', 'system.health'], render: renderReports },
  { path: 'notify-monitor', position: 'admin', title_th: 'ติดตามการส่งแจ้งเตือน', icon: '📮', anyOf: ['notification.monitor'], render: renderNotifyMonitor },
  { path: 'line-link', hidden: true, title_th: 'เชื่อมบัญชี LINE', icon: '💬', render: renderLineLink },
  { path: 'profile', hidden: true, title_th: 'ประวัตินักเรียน', icon: '👤', anyOf: ['student.read', 'student.read_basic'], render: renderProfile },
];
