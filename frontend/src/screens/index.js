// Route table. `anyOf` lists permission actions (from auth.getCurrentUser.actions) that reveal a menu
// item; the server still checks every operation — hiding a menu is never the security control.
import { renderHome } from './home.js';
import { renderStudents } from './students.js';
import { renderUsers } from './users.js';
import { renderSettings } from './settings.js';
import { renderImports } from './imports.js';
import { renderHealth } from './health.js';
import { EXTRA_ROUTES } from './extra.js';

export const ROUTES = [
  { path: 'home', title_th: 'หน้าหลัก', icon: '🏠', render: renderHome },
  ...EXTRA_ROUTES.filter((r) => r.position === 'top'),
  { path: 'students', title_th: 'รายชื่อนักเรียน', icon: '🎓', anyOf: ['student.search', 'student.read'], render: renderStudents },
  ...EXTRA_ROUTES.filter((r) => r.position !== 'top' && r.position !== 'admin'),
  { path: 'imports', title_th: 'ศูนย์นำเข้าข้อมูล', icon: '📥', anyOf: ['import.manage'], render: renderImports },
  { path: 'users', title_th: 'ผู้ใช้และสิทธิ์', icon: '👥', anyOf: ['user.read'], render: renderUsers },
  { path: 'settings', title_th: 'ตั้งค่า', icon: '⚙', anyOf: ['settings.business', 'system.health'], render: renderSettings },
  ...EXTRA_ROUTES.filter((r) => r.position === 'admin'),
  { path: 'health', title_th: 'สถานะระบบ', icon: '🩺', anyOf: ['system.health'], render: renderHealth },
];
