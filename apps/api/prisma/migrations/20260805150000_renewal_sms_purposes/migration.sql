ALTER TYPE "customer_verification_code_purpose" ADD VALUE IF NOT EXISTS 'RENEWAL_REMINDER_D30';
ALTER TYPE "customer_verification_code_purpose" ADD VALUE IF NOT EXISTS 'RENEWAL_REMINDER_D14';
ALTER TYPE "customer_verification_code_purpose" ADD VALUE IF NOT EXISTS 'RENEWAL_REMINDER_D3';
ALTER TYPE "customer_verification_code_purpose" ADD VALUE IF NOT EXISTS 'RENEWAL_EXPIRY_RETURN';
ALTER TYPE "customer_verification_code_purpose" ADD VALUE IF NOT EXISTS 'RENEWAL_RETURN_OVERDUE_D1';
