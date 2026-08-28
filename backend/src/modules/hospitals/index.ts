export { hospitalRouter } from './routes/hospital.routes.js';
export {
  requireHospitalMembership,
  requireHospitalStaffRole,
} from './middleware/hospital-scope.middleware.js';
export type { HospitalStaffContext } from './types/hospital.types.js';
