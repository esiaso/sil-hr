# Performance

Measured by `pnpm --filter @sil/hr-api bench` (`apps/api/test/perf/perf.bench.ts`) on
2026-11-19: the API in-process against PostgreSQL 16 in Docker on a
developer laptop, with the sample hospital plus a generated workforce. Timings are server
work (queries, mapping, serialisation) without network or the browser. Run it again on the
production hardware before go-live.

## Dataset

| Table | Rows |
|---|---|
| employee | 2,000 |
| attendance_day | 1,353,878 |
| clock_event | 2,707,869 |
| leave_ledger | 29,964 |
| professional_licence | 1,297 |
| employee_salary | 2,000 |

Sizes: attendance_day 355 MB, clock_event 810 MB, whole database 1198 MB.

| Setup step | Seconds |
|---|---|
| Insert 1958 more employees, assignments, salaries and licences | 0.6 |
| 3 years of daily attendance (weekdays) and two punches a day | 297.3 |
| Leave accrual for every employee (the hourly job) | 53.1 |

## Timings (milliseconds)

| Operation | Runs | p50 | p95 | Max | Note |
|---|---|---|---|---|---|
| Sign in (password check, token) | 10 | 55 | 76 | 76 | Argon2id hashing dominates by design |
| Employee list, first page of 50 | 20 | 14 | 120 | 120 |  |
| Employee search by name | 20 | 15 | 24 | 24 |  |
| Employee record | 20 | 8 | 13 | 13 |  |
| Staff directory, department and below | 20 | 24 | 35 | 35 |  |
| Daily attendance, one department, one month | 20 | 31 | 56 | 56 |  |
| Timesheet, one person, one month | 20 | 8 | 45 | 45 |  |
| My leave balances | 20 | 41 | 95 | 95 |  |
| Approvals inbox | 20 | 5 | 14 | 14 |  |
| Dashboard (HR manager) | 20 | 15 | 35 | 35 |  |
| Headcount report by department | 10 | 28 | 38 | 38 |  |
| Turnover report, one year | 10 | 15 | 29 | 29 |  |
| Overtime cost report, twelve months | 5 | 207 | 354 | 354 | 1,353,878 attendance rows scanned |
| Leave liability report | 5 | 74 | 146 | 146 |  |
| Licence expiry report, 90 days | 10 | 16 | 28 | 28 |  |
| Headcount report, Excel download | 5 | 36 | 74 | 74 |  |
| FHIR Practitioner search, 100 | 10 | 57 | 112 | 112 |  |
| My calendar, one month | 20 | 21 | 85 | 85 |  |
| Payroll calculation, whole hospital (2,000 staff) | 1 | 46710 | 46710 | 46710 | Once; statutory deductions, overtime and leave for everyone |
| Payroll variance against the previous month | 3 | 156 | 176 | 176 |  |
| Payslips of the run, first 200 | 5 | 166 | 187 | 187 |  |
| Statutory remittances report, twelve months | 5 | 6 | 9 | 9 |  |

## Reading the numbers

* Screens staff use all day (lists, records, the inbox, balances, calendar, dashboard)
  should stay well under 300 ms at p95; reports and downloads under a few seconds.
* Payroll calculation is a once-a-month action, measured once. About 23 ms a person, done
  one person at a time in one transaction; at 2,000 staff it takes under a minute, so a
  reverse proxy in front of the API must allow requests of at least two minutes on
  `POST /payroll/runs/{id}/calculate` (see DEPLOYMENT.md). Batching the per-person queries
  is the first optimisation if the hospital grows much larger.
* Attendance grows by about 520,000 rows a year for 2,000 staff (weekdays only here;
  shift workers add weekends). Queries filter by employee or department and date, which the
  indexes `(employee_id, work_date)` and `ix_attendance_date` serve; partitioning by year is
  not needed at this size.
