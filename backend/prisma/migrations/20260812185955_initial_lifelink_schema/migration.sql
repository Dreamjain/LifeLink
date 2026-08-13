-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('PATIENT', 'DRIVER', 'HOSPITAL_STAFF', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'REJECTED');

-- CreateEnum
CREATE TYPE "HospitalStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'TEMPORARILY_UNAVAILABLE', 'SUSPENDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AmbulanceStatus" AS ENUM ('AVAILABLE', 'OFFERED', 'ASSIGNED', 'EN_ROUTE', 'OUT_OF_SERVICE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "BedStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'OCCUPIED', 'OUT_OF_SERVICE');

-- CreateEnum
CREATE TYPE "EmergencyStatus" AS ENUM ('CREATED', 'SEARCHING_HOSPITAL', 'PENDING_HOSPITAL_RESPONSE', 'HOSPITAL_REJECTED', 'HOSPITAL_ACCEPTED', 'BED_RESERVED', 'AMBULANCE_ASSIGNED', 'PENDING_DRIVER_ACCEPTANCE', 'DRIVER_EN_ROUTE', 'AT_PICKUP', 'TRANSPORTING', 'AT_HOSPITAL', 'ADMITTED', 'COMPLETED', 'CANCELLED', 'ESCALATED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "HospitalResponseStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "AmbulanceAssignmentStatus" AS ENUM ('OFFERED', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EN_ROUTE', 'AT_PICKUP', 'TRANSPORTING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "BedReservationStatus" AS ENUM ('RESERVED', 'RELEASED', 'EXPIRED', 'CONSUMED', 'FAILED');

-- CreateEnum
CREATE TYPE "DoctorAssignmentStatus" AS ENUM ('ASSIGNED', 'RELEASED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'SIMULATED_CONTACT', 'SMS', 'WHATSAPP', 'PUSH', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BloodGroup" AS ENUM ('A_POSITIVE', 'A_NEGATIVE', 'B_POSITIVE', 'B_NEGATIVE', 'AB_POSITIVE', 'AB_NEGATIVE', 'O_POSITIVE', 'O_NEGATIVE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "MedicalReportType" AS ENUM ('PRESCRIPTION', 'LAB_REPORT', 'SCAN', 'DISCHARGE_SUMMARY', 'MEDICAL_HISTORY', 'OTHER');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "HospitalStaffRole" AS ENUM ('ADMIN', 'DISPATCHER', 'RECEPTIONIST', 'CLINICAL_COORDINATOR');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REMOVED');

-- CreateEnum
CREATE TYPE "DoctorStatus" AS ENUM ('AVAILABLE', 'BUSY', 'ON_LEAVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "BedType" AS ENUM ('GENERAL', 'ICU', 'EMERGENCY', 'ISOLATION');

-- CreateEnum
CREATE TYPE "AmbulanceType" AS ENUM ('BASIC_LIFE_SUPPORT', 'ADVANCED_LIFE_SUPPORT', 'PATIENT_TRANSPORT');

-- CreateEnum
CREATE TYPE "EmergencyType" AS ENUM ('SOS', 'AMBULANCE_REQUEST');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DriverAvailability" AS ENUM ('OFFLINE', 'AVAILABLE', 'BUSY', 'ON_BREAK', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('EMERGENCY_CREATED', 'HOSPITAL_REQUEST', 'HOSPITAL_ACCEPTED', 'HOSPITAL_REJECTED', 'AMBULANCE_ASSIGNED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'PATIENT_PICKED_UP', 'HOSPITAL_ARRIVAL', 'PATIENT_ADMITTED', 'EMERGENCY_COMPLETED', 'EMERGENCY_CANCELLED', 'GENERAL');

-- CreateEnum
CREATE TYPE "TransitionActorType" AS ENUM ('SYSTEM', 'PATIENT', 'HOSPITAL_STAFF', 'DRIVER', 'ADMIN');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "email" VARCHAR(254),
    "passwordHash" VARCHAR(255),
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',
    "displayName" VARCHAR(120) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientProfile" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "dateOfBirth" DATE,
    "gender" VARCHAR(32),
    "bloodGroup" "BloodGroup",
    "allergies" TEXT,
    "medicalSummary" TEXT,
    "addressLine" VARCHAR(255),
    "city" VARCHAR(100),
    "state" VARCHAR(100),
    "postalCode" VARCHAR(20),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PatientProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyContact" (
    "id" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "relationship" VARCHAR(60) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "EmergencyContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicalReport" (
    "id" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "reportType" "MedicalReportType" NOT NULL DEFAULT 'OTHER',
    "displayName" VARCHAR(255) NOT NULL,
    "storageKey" VARCHAR(512) NOT NULL,
    "mimeType" VARCHAR(100) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" VARCHAR(128),
    "consentStatus" "ConsentStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MedicalReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hospital" (
    "id" UUID NOT NULL,
    "name" VARCHAR(180) NOT NULL,
    "registrationNumber" VARCHAR(100) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "email" VARCHAR(254),
    "addressLine" VARCHAR(255) NOT NULL,
    "city" VARCHAR(100) NOT NULL,
    "state" VARCHAR(100) NOT NULL,
    "postalCode" VARCHAR(20) NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "capabilities" JSONB NOT NULL DEFAULT '[]',
    "status" "HospitalStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Hospital_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospitalStaffMembership" (
    "id" UUID NOT NULL,
    "hospitalId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "staffRole" "HospitalStaffRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "HospitalStaffMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Doctor" (
    "id" UUID NOT NULL,
    "hospitalId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "registrationNumber" VARCHAR(100) NOT NULL,
    "specialty" VARCHAR(100),
    "status" "DoctorStatus" NOT NULL DEFAULT 'AVAILABLE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Doctor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bed" (
    "id" UUID NOT NULL,
    "hospitalId" UUID NOT NULL,
    "bedCode" VARCHAR(50) NOT NULL,
    "bedType" "BedType" NOT NULL DEFAULT 'GENERAL',
    "status" "BedStatus" NOT NULL DEFAULT 'AVAILABLE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Bed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ambulance" (
    "id" UUID NOT NULL,
    "hospitalId" UUID NOT NULL,
    "vehicleNumber" VARCHAR(30) NOT NULL,
    "ambulanceType" "AmbulanceType" NOT NULL DEFAULT 'BASIC_LIFE_SUPPORT',
    "capabilities" JSONB NOT NULL DEFAULT '[]',
    "status" "AmbulanceStatus" NOT NULL DEFAULT 'AVAILABLE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Ambulance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverProfile" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "licenceNumber" VARCHAR(80) NOT NULL,
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "availabilityStatus" "DriverAvailability" NOT NULL DEFAULT 'OFFLINE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "DriverProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyRequest" (
    "id" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "requestType" "EmergencyType" NOT NULL DEFAULT 'SOS',
    "severity" "Severity" NOT NULL DEFAULT 'UNKNOWN',
    "currentStatus" "EmergencyStatus" NOT NULL DEFAULT 'CREATED',
    "description" TEXT,
    "pickupAddress" VARCHAR(500),
    "pickupLatitude" DECIMAL(9,6),
    "pickupLongitude" DECIMAL(9,6),
    "idempotencyKey" VARCHAR(128),
    "cancelledAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "EmergencyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospitalResponse" (
    "id" UUID NOT NULL,
    "emergencyId" UUID NOT NULL,
    "hospitalId" UUID NOT NULL,
    "attemptNumber" SMALLINT NOT NULL DEFAULT 1,
    "status" "HospitalResponseStatus" NOT NULL DEFAULT 'PENDING',
    "rank" INTEGER,
    "estimatedDistanceKm" DECIMAL(8,2),
    "responseByUserId" UUID,
    "rejectionReason" TEXT,
    "offeredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "HospitalResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmbulanceAssignment" (
    "id" UUID NOT NULL,
    "emergencyId" UUID NOT NULL,
    "hospitalResponseId" UUID NOT NULL,
    "ambulanceId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "attemptNumber" SMALLINT NOT NULL DEFAULT 1,
    "status" "AmbulanceAssignmentStatus" NOT NULL DEFAULT 'OFFERED',
    "rejectionReason" TEXT,
    "assignedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMPTZ(6),
    "startedAt" TIMESTAMPTZ(6),
    "endedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AmbulanceAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BedReservation" (
    "id" UUID NOT NULL,
    "emergencyId" UUID NOT NULL,
    "hospitalResponseId" UUID NOT NULL,
    "bedId" UUID NOT NULL,
    "status" "BedReservationStatus" NOT NULL DEFAULT 'RESERVED',
    "reservedByUserId" UUID,
    "reservedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6),
    "releasedAt" TIMESTAMPTZ(6),
    "releaseReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BedReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoctorAssignment" (
    "id" UUID NOT NULL,
    "emergencyId" UUID NOT NULL,
    "doctorId" UUID NOT NULL,
    "status" "DoctorAssignmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "assignedByUserId" UUID,
    "assignedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMPTZ(6),
    "releaseReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "DoctorAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyStatusHistory" (
    "id" UUID NOT NULL,
    "emergencyId" UUID NOT NULL,
    "fromStatus" "EmergencyStatus",
    "toStatus" "EmergencyStatus" NOT NULL,
    "actorUserId" UUID,
    "actorType" "TransitionActorType" NOT NULL DEFAULT 'SYSTEM',
    "reason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmergencyStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "emergencyId" UUID NOT NULL,
    "recipientUserId" UUID,
    "emergencyContactId" UUID,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'IN_APP',
    "type" "NotificationType" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "title" VARCHAR(160) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "scheduledAt" TIMESTAMPTZ(6),
    "sentAt" TIMESTAMPTZ(6),
    "readAt" TIMESTAMPTZ(6),
    "failedAt" TIMESTAMPTZ(6),
    "failureReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PatientProfile_userId_key" ON "PatientProfile"("userId");

-- CreateIndex
CREATE INDEX "EmergencyContact_patientId_idx" ON "EmergencyContact"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "MedicalReport_storageKey_key" ON "MedicalReport"("storageKey");

-- CreateIndex
CREATE INDEX "MedicalReport_patientId_idx" ON "MedicalReport"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "Hospital_registrationNumber_key" ON "Hospital"("registrationNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Hospital_email_key" ON "Hospital"("email");

-- CreateIndex
CREATE INDEX "HospitalStaffMembership_userId_idx" ON "HospitalStaffMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "HospitalStaffMembership_hospitalId_userId_key" ON "HospitalStaffMembership"("hospitalId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Doctor_registrationNumber_key" ON "Doctor"("registrationNumber");

-- CreateIndex
CREATE INDEX "Doctor_hospitalId_idx" ON "Doctor"("hospitalId");

-- CreateIndex
CREATE INDEX "Bed_hospitalId_status_idx" ON "Bed"("hospitalId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Bed_hospitalId_bedCode_key" ON "Bed"("hospitalId", "bedCode");

-- CreateIndex
CREATE UNIQUE INDEX "Ambulance_vehicleNumber_key" ON "Ambulance"("vehicleNumber");

-- CreateIndex
CREATE INDEX "Ambulance_status_idx" ON "Ambulance"("status");

-- CreateIndex
CREATE INDEX "Ambulance_hospitalId_idx" ON "Ambulance"("hospitalId");

-- CreateIndex
CREATE UNIQUE INDEX "DriverProfile_userId_key" ON "DriverProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DriverProfile_licenceNumber_key" ON "DriverProfile"("licenceNumber");

-- CreateIndex
CREATE INDEX "DriverProfile_availabilityStatus_idx" ON "DriverProfile"("availabilityStatus");

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyRequest_idempotencyKey_key" ON "EmergencyRequest"("idempotencyKey");

-- CreateIndex
CREATE INDEX "EmergencyRequest_currentStatus_idx" ON "EmergencyRequest"("currentStatus");

-- CreateIndex
CREATE INDEX "EmergencyRequest_patientId_idx" ON "EmergencyRequest"("patientId");

-- CreateIndex
CREATE INDEX "HospitalResponse_emergencyId_status_idx" ON "HospitalResponse"("emergencyId", "status");

-- CreateIndex
CREATE INDEX "HospitalResponse_hospitalId_idx" ON "HospitalResponse"("hospitalId");

-- CreateIndex
CREATE INDEX "HospitalResponse_responseByUserId_idx" ON "HospitalResponse"("responseByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "HospitalResponse_emergencyId_hospitalId_attemptNumber_key" ON "HospitalResponse"("emergencyId", "hospitalId", "attemptNumber");

-- CreateIndex
CREATE INDEX "AmbulanceAssignment_emergencyId_status_idx" ON "AmbulanceAssignment"("emergencyId", "status");

-- CreateIndex
CREATE INDEX "AmbulanceAssignment_hospitalResponseId_idx" ON "AmbulanceAssignment"("hospitalResponseId");

-- CreateIndex
CREATE INDEX "AmbulanceAssignment_ambulanceId_idx" ON "AmbulanceAssignment"("ambulanceId");

-- CreateIndex
CREATE INDEX "AmbulanceAssignment_driverId_idx" ON "AmbulanceAssignment"("driverId");

-- CreateIndex
CREATE UNIQUE INDEX "AmbulanceAssignment_emergencyId_attemptNumber_key" ON "AmbulanceAssignment"("emergencyId", "attemptNumber");

-- CreateIndex
CREATE INDEX "BedReservation_emergencyId_idx" ON "BedReservation"("emergencyId");

-- CreateIndex
CREATE INDEX "BedReservation_hospitalResponseId_idx" ON "BedReservation"("hospitalResponseId");

-- CreateIndex
CREATE INDEX "BedReservation_bedId_idx" ON "BedReservation"("bedId");

-- CreateIndex
CREATE INDEX "BedReservation_reservedByUserId_idx" ON "BedReservation"("reservedByUserId");

-- CreateIndex
CREATE INDEX "DoctorAssignment_emergencyId_idx" ON "DoctorAssignment"("emergencyId");

-- CreateIndex
CREATE INDEX "DoctorAssignment_doctorId_idx" ON "DoctorAssignment"("doctorId");

-- CreateIndex
CREATE INDEX "DoctorAssignment_assignedByUserId_idx" ON "DoctorAssignment"("assignedByUserId");

-- CreateIndex
CREATE INDEX "EmergencyStatusHistory_emergencyId_occurredAt_idx" ON "EmergencyStatusHistory"("emergencyId", "occurredAt");

-- CreateIndex
CREATE INDEX "EmergencyStatusHistory_actorUserId_idx" ON "EmergencyStatusHistory"("actorUserId");

-- CreateIndex
CREATE INDEX "Notification_emergencyId_status_idx" ON "Notification"("emergencyId", "status");

-- CreateIndex
CREATE INDEX "Notification_recipientUserId_idx" ON "Notification"("recipientUserId");

-- CreateIndex
CREATE INDEX "Notification_emergencyContactId_idx" ON "Notification"("emergencyContactId");

-- AddForeignKey
ALTER TABLE "PatientProfile" ADD CONSTRAINT "PatientProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyContact" ADD CONSTRAINT "EmergencyContact_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "PatientProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicalReport" ADD CONSTRAINT "MedicalReport_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "PatientProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalStaffMembership" ADD CONSTRAINT "HospitalStaffMembership_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalStaffMembership" ADD CONSTRAINT "HospitalStaffMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Doctor" ADD CONSTRAINT "Doctor_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bed" ADD CONSTRAINT "Bed_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ambulance" ADD CONSTRAINT "Ambulance_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverProfile" ADD CONSTRAINT "DriverProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyRequest" ADD CONSTRAINT "EmergencyRequest_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "PatientProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalResponse" ADD CONSTRAINT "HospitalResponse_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "EmergencyRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalResponse" ADD CONSTRAINT "HospitalResponse_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalResponse" ADD CONSTRAINT "HospitalResponse_responseByUserId_fkey" FOREIGN KEY ("responseByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmbulanceAssignment" ADD CONSTRAINT "AmbulanceAssignment_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "EmergencyRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmbulanceAssignment" ADD CONSTRAINT "AmbulanceAssignment_hospitalResponseId_fkey" FOREIGN KEY ("hospitalResponseId") REFERENCES "HospitalResponse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmbulanceAssignment" ADD CONSTRAINT "AmbulanceAssignment_ambulanceId_fkey" FOREIGN KEY ("ambulanceId") REFERENCES "Ambulance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmbulanceAssignment" ADD CONSTRAINT "AmbulanceAssignment_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "DriverProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BedReservation" ADD CONSTRAINT "BedReservation_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "EmergencyRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BedReservation" ADD CONSTRAINT "BedReservation_hospitalResponseId_fkey" FOREIGN KEY ("hospitalResponseId") REFERENCES "HospitalResponse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BedReservation" ADD CONSTRAINT "BedReservation_bedId_fkey" FOREIGN KEY ("bedId") REFERENCES "Bed"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BedReservation" ADD CONSTRAINT "BedReservation_reservedByUserId_fkey" FOREIGN KEY ("reservedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorAssignment" ADD CONSTRAINT "DoctorAssignment_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "EmergencyRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorAssignment" ADD CONSTRAINT "DoctorAssignment_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorAssignment" ADD CONSTRAINT "DoctorAssignment_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyStatusHistory" ADD CONSTRAINT "EmergencyStatusHistory_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "EmergencyRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyStatusHistory" ADD CONSTRAINT "EmergencyStatusHistory_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "EmergencyRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_emergencyContactId_fkey" FOREIGN KEY ("emergencyContactId") REFERENCES "EmergencyContact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Custom integrity constraints intentionally kept in this initial migration.
-- Prisma schema syntax cannot express these PostgreSQL constraints directly.
ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_exactly_one_recipient_check"
  CHECK (("recipientUserId" IS NOT NULL) <> ("emergencyContactId" IS NOT NULL));

CREATE UNIQUE INDEX "EmergencyContact_one_primary_per_patient_key"
  ON "EmergencyContact"("patientId")
  WHERE "isPrimary" = true;

ALTER TABLE "Hospital"
  ADD CONSTRAINT "Hospital_latitude_range_check"
  CHECK ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "Hospital_longitude_range_check"
  CHECK ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180);

ALTER TABLE "EmergencyRequest"
  ADD CONSTRAINT "EmergencyRequest_pickup_latitude_range_check"
  CHECK ("pickupLatitude" IS NULL OR "pickupLatitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "EmergencyRequest_pickup_longitude_range_check"
  CHECK ("pickupLongitude" IS NULL OR "pickupLongitude" BETWEEN -180 AND 180);

ALTER TABLE "HospitalResponse"
  ADD CONSTRAINT "HospitalResponse_estimated_distance_nonnegative_check"
  CHECK ("estimatedDistanceKm" IS NULL OR "estimatedDistanceKm" >= 0);

ALTER TABLE "MedicalReport"
  ADD CONSTRAINT "MedicalReport_size_bytes_nonnegative_check"
  CHECK ("sizeBytes" >= 0);
