export {
  createAssignment as createHospitalAssignment,
  getAssignment as getHospitalAssignment,
  listAssignments as listHospitalAssignments,
} from './controllers/hospital-assignment.controller.js';
export {
  acceptAssignment as acceptDriverAssignment,
  getAssignment as getDriverAssignment,
  listAssignments as listDriverAssignments,
  rejectAssignment as rejectDriverAssignment,
} from './controllers/driver-assignment.controller.js';
export type { DriverContext } from './types/dispatch.types.js';
