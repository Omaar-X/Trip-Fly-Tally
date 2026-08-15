-- ============================================================================
--  Migration 004 — remove the attendance module
-- ----------------------------------------------------------------------------
--  Attendance is kept in a separate system, so this ERP stops owning it.
--
--  What that means for payroll: the salary engine used to derive the absence
--  deduction from attendance —
--
--      perDay      = gross / workingDays
--      absenceDed  = perDay x (workingDays - presentDays)
--
--  With no attendance to read, working days and present days are meaningless
--  here, so they go. The deduction becomes a plain taka figure entered per
--  employee when the run is generated: computed wherever attendance actually
--  lives, and simply recorded here.
--
--  `payslips.other_deduction` already existed for exactly this shape of value
--  and is renamed to `deduction`, since it is now the only one.
--
--  DESTRUCTIVE: drops the `attendance` table and three `payslips` columns.
--  Take a backup first if this database has ever recorded attendance:
--      mysqldump -u root -p erp_db attendance > attendance-backup.sql
--
--  Usage:
--    mysql -u root -p --default-character-set=utf8mb4 erp_db < database/migrations/004_remove_attendance.sql
-- ============================================================================

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------
-- 1 · payslips — replace the attendance-derived columns with one deduction
-- ---------------------------------------------------------------------------
-- Anything already recorded as an absence deduction is folded into the single
-- deduction column first, so no payslip's net pay changes.

SET @sql := (
  SELECT IF(COUNT(*) = 1,
    'UPDATE payslips SET other_deduction = other_deduction + absence_deduction WHERE absence_deduction <> 0',
    'SELECT "payslips.absence_deduction already removed"')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'payslips' AND column_name = 'absence_deduction');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(COUNT(*) = 1,
    'ALTER TABLE payslips DROP COLUMN absence_deduction',
    'SELECT "payslips.absence_deduction already removed"')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'payslips' AND column_name = 'absence_deduction');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(COUNT(*) = 1,
    'ALTER TABLE payslips DROP COLUMN working_days',
    'SELECT "payslips.working_days already removed"')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'payslips' AND column_name = 'working_days');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(COUNT(*) = 1,
    'ALTER TABLE payslips DROP COLUMN present_days',
    'SELECT "payslips.present_days already removed"')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'payslips' AND column_name = 'present_days');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- "other" only made sense while an absence deduction sat beside it.
SET @sql := (
  SELECT IF(COUNT(*) = 1,
    'ALTER TABLE payslips CHANGE COLUMN other_deduction deduction DECIMAL(14,2) NOT NULL DEFAULT 0.00',
    'SELECT "payslips.deduction already renamed"')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'payslips' AND column_name = 'other_deduction');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ---------------------------------------------------------------------------
-- 2 · drop the attendance table
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS attendance;

SELECT 'Migration 004 (attendance removed) applied.' AS status;
