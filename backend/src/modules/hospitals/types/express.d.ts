import type { HospitalStaffContext } from './hospital.types.js';

declare global {
  namespace Express {
    interface Request {
      hospitalStaff?: HospitalStaffContext;
    }
  }
}

export {};
