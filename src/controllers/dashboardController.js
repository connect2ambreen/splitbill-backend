import redis from "../config/redis.js";
import { query } from "../config/db.js";

const CACHE_TTL = {
  dashboard: 60,      // 60 seconds — balance + stats
  groups: 120,        // 2 minutes — group list changes less often
  activity: 30,       // 30 seconds — recent activity changes more often
};

// ─── helpers ──────────────────────────────────────────────────────────────────

const cacheKey = {
  dashboard: (userId) => `dashboard:${userId}`,
  groups: (userId) => `dashboard:groups:${userId}`,
  activity: (userId) => `dashboard:activity:${userId}`,
};

// Invalidate all dashboard cache for a user — call this from any controller
// that modifies expenses, settlements, or group membership
export const invalidateDashboardCache = async (userId) => {
  try {
    await Promise.allSettled([
      redis().del(cacheKey.dashboard(userId)),
      redis().del(cacheKey.groups(userId)),
      redis().del(cacheKey.activity(userId)),
    ]);
  } catch (err) {
    console.warn('Cache invalidation failed:', err.message);
  }
};

// ─── main handler ─────────────────────────────────────────────────────────────

export const getDashboardData = async (req, res) => {
  try {
    const { user_id } = req.params;

    // ── 1. Try cache first ───────────────────────────────────────────────────
    // FIX: Parse cached values from JSON strings since Redis stores strings
    const [cachedDash, cachedGroups, cachedActivity] = await Promise.allSettled([
      redis().get(cacheKey.dashboard(user_id)),
      redis().get(cacheKey.groups(user_id)),
      redis().get(cacheKey.activity(user_id)),
    ]);

    const dashRaw = cachedDash.status === 'fulfilled' ? cachedDash.value : null;
    const groupsRaw = cachedGroups.status === 'fulfilled' ? cachedGroups.value : null;
    const actRaw = cachedActivity.status === 'fulfilled' ? cachedActivity.value : null;

    // FIX: Safely parse each cached value — a parse error means treat as cache miss
    let dashData = null;
    let groupsData = null;
    let actData = null;

    try { dashData = dashRaw ? JSON.parse(dashRaw) : null; } catch { dashData = null; }
    try { groupsData = groupsRaw ? JSON.parse(groupsRaw) : null; } catch { groupsData = null; }
    try { actData = actRaw ? JSON.parse(actRaw) : null; } catch { actData = null; }

    // Full cache hit — return immediately
    if (dashData && groupsData && actData) {
      return res.json({
        success: true,
        fromCache: true,
        data: { ...dashData, groups: groupsData, recentActivity: actData },
      });
    }

    // ── 2. Cache miss — run only the queries we need ─────────────────────────
    const queriesToRun = [];

    if (!dashData) {
      queriesToRun.push(
        // Balance
        query(`
          SELECT
            COALESCE(SUM(CASE WHEN es.paid_share > es.owed_share THEN es.paid_share - es.owed_share ELSE 0 END), 0) as you_are_owed,
            COALESCE(SUM(CASE WHEN es.owed_share > es.paid_share THEN es.owed_share - es.paid_share ELSE 0 END), 0) as you_owe
          FROM expense_shares es
          JOIN expenses e ON es.expense_id = e.id
          WHERE es.user_id = $1 AND e.is_deleted = false`, [user_id]),

        // Current month total
        query(`
          SELECT COALESCE(SUM(es.owed_share), 0) AS total
          FROM expense_shares es
          JOIN expenses e ON es.expense_id = e.id
          WHERE es.user_id = $1
            AND DATE_TRUNC('month', e.created_at) = DATE_TRUNC('month', CURRENT_DATE)
            AND e.is_deleted = false`, [user_id]),

        // Previous month total
        query(`
          SELECT COALESCE(SUM(es.owed_share), 0) AS total
          FROM expense_shares es
          JOIN expenses e ON es.expense_id = e.id
          WHERE es.user_id = $1
            AND DATE_TRUNC('month', e.created_at) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
            AND e.is_deleted = false`, [user_id]),

        // FIX: Current month weekly — join order fixed so expense_shares drives
        // the user filter, expenses provides the date. This ensures we never
        // miss rows when the LEFT JOIN produces nulls on the wrong side.
        query(`
          WITH month_bounds AS (
            SELECT
              DATE_TRUNC('month', CURRENT_DATE)                              AS month_start,
              DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'        AS month_end
          ),
          week_ranges AS (
            SELECT
              wn.week_num,
              mb.month_start + ((wn.week_num - 1) * INTERVAL '7 days')                         AS week_start,
              LEAST(mb.month_start + (wn.week_num * INTERVAL '7 days'), mb.month_end)          AS week_end
            FROM (SELECT generate_series(1, 5) AS week_num) wn
            CROSS JOIN month_bounds mb
          )
          SELECT
            wr.week_num,
            COALESCE(SUM(es.owed_share), 0) AS amount
          FROM week_ranges wr
          LEFT JOIN expenses e
            ON e.created_at >= wr.week_start
           AND e.created_at <  wr.week_end
           AND e.is_deleted = false
          LEFT JOIN expense_shares es
            ON es.expense_id = e.id
           AND es.user_id = $1
          GROUP BY wr.week_num
          ORDER BY wr.week_num`, [user_id]),

        // FIX: Previous month weekly — same join-order fix
        query(`
          WITH month_bounds AS (
            SELECT
              DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')        AS month_start,
              DATE_TRUNC('month', CURRENT_DATE)                              AS month_end
          ),
          week_ranges AS (
            SELECT
              wn.week_num,
              mb.month_start + ((wn.week_num - 1) * INTERVAL '7 days')                         AS week_start,
              LEAST(mb.month_start + (wn.week_num * INTERVAL '7 days'), mb.month_end)          AS week_end
            FROM (SELECT generate_series(1, 5) AS week_num) wn
            CROSS JOIN month_bounds mb
          )
          SELECT
            wr.week_num,
            COALESCE(SUM(es.owed_share), 0) AS amount
          FROM week_ranges wr
          LEFT JOIN expenses e
            ON e.created_at >= wr.week_start
           AND e.created_at <  wr.week_end
           AND e.is_deleted = false
          LEFT JOIN expense_shares es
            ON es.expense_id = e.id
           AND es.user_id = $1
          GROUP BY wr.week_num
          ORDER BY wr.week_num`, [user_id]),

        // Category (current month)
        query(`
          SELECT
            LOWER(COALESCE(ec.name, 'uncategorized')) AS category,
            COALESCE(SUM(es.owed_share), 0)           AS amount
          FROM expense_shares es
          JOIN expenses e  ON es.expense_id = e.id
          LEFT JOIN expense_categories ec ON e.category_id = ec.id
          WHERE es.user_id = $1
            AND e.is_deleted = false
            AND DATE_TRUNC('month', e.created_at) = DATE_TRUNC('month', CURRENT_DATE)
          GROUP BY LOWER(COALESCE(ec.name, 'uncategorized'))`, [user_id])
      );
    }

    if (!actData) {
      queriesToRun.push(
        query(`
          SELECT a.id, a.activity_type, a.description, a.amount, a.currency, a.created_at,
                 e.description as expense_description, ec.name as category_name
          FROM activities a
          LEFT JOIN expenses e ON a.related_expense_id = e.id
          LEFT JOIN expense_categories ec ON e.category_id = ec.id
          WHERE a.user_id = $1
             OR a.group_id IN (SELECT group_id FROM group_members WHERE user_id = $1)
          ORDER BY a.created_at DESC LIMIT 10`, [user_id])
      );
    }

    if (!groupsData) {
      queriesToRun.push(
        query(`
          SELECT
            g.id, g.name, g.description, g.group_type, g.default_currency,
            g.avatar_url, g.invite_code, g.created_at,
            u.name as created_by_name,
            COUNT(DISTINCT gm.user_id) as member_count,
            gm_current.role as user_role
          FROM groups g
          JOIN group_members gm_current ON g.id = gm_current.group_id AND gm_current.user_id = $1
          LEFT JOIN group_members gm ON g.id = gm.group_id AND gm.is_active = true
          LEFT JOIN users u ON g.created_by = u.id
          WHERE gm_current.is_active = true AND g.is_active = true
          GROUP BY g.id, g.name, g.description, g.group_type, g.default_currency,
                   g.avatar_url, g.invite_code, g.created_at, u.name, gm_current.role
          ORDER BY g.created_at DESC`, [user_id])
      );
    }

    const results = await Promise.all(queriesToRun);

    // ── 3. Parse results ─────────────────────────────────────────────────────
    let finalDash = dashData;
    let finalAct = actData;
    let finalGroups = groupsData;

    let idx = 0;

    if (!dashData) {
      // 6 queries: balance, monthly, previous, weekly, lastMonthWeekly, category
      const [balance, monthly, previous, weekly, lastMonthWeekly, category] = results.slice(0, 6);
      idx = 6;

      console.log('Dashboard Debug - Balance rows:', balance.rows);
      console.log('Dashboard Debug - Monthly rows:', monthly.rows);
      console.log('Dashboard Debug - Previous rows:', previous.rows);
      console.log('Dashboard Debug - Weekly rows:', weekly.rows);
      console.log('Dashboard Debug - Last Month Weekly rows:', lastMonthWeekly.rows);
      console.log('Dashboard Debug - Category rows:', category.rows);

      // FIX: Ensure we always have exactly 5 entries (one per week slot),
      // defaulting to 0 for any missing week_num returned by the query.
      const weeklyData = [0, 0, 0, 0, 0];
      weekly.rows.forEach(r => {
        const i = parseInt(r.week_num, 10) - 1; // week_num is 1-based
        if (i >= 0 && i < 5) weeklyData[i] = parseFloat(r.amount) || 0;
      });

      const lastMonthWeeklyData = [0, 0, 0, 0, 0];
      lastMonthWeekly.rows.forEach(r => {
        const i = parseInt(r.week_num, 10) - 1;
        if (i >= 0 && i < 5) lastMonthWeeklyData[i] = parseFloat(r.amount) || 0;
      });

      const categoryData = { food: 0, transport: 0, entertainment: 0, utilities: 0 };
      category.rows.forEach(r => {
        if (Object.prototype.hasOwnProperty.call(categoryData, r.category)) {
          categoryData[r.category] = parseFloat(r.amount) || 0;
        }
      });

      console.log('Dashboard Debug - Processed weeklyData:', weeklyData);
      console.log('Dashboard Debug - Processed lastMonthWeeklyData:', lastMonthWeeklyData);
      console.log('Dashboard Debug - Processed categoryData:', categoryData);

      const totalThisMonth = parseFloat(monthly.rows[0]?.total || 0);
      const totalLastMonth = parseFloat(previous.rows[0]?.total || 0);

      const changePercent = totalLastMonth > 0
        ? Math.round(((totalThisMonth - totalLastMonth) / totalLastMonth) * 100)
        : 0;

      finalDash = {
        balance: {
          youOwe: parseFloat(balance.rows[0]?.you_owe || 0),
          youAreOwed: parseFloat(balance.rows[0]?.you_are_owed || 0),
        },
        monthlyStats: {
          totalThisMonth,
          totalLastMonth,
          changePercent,
        },
        weeklyData,
        lastMonthWeeklyData,
        categoryData,
      };
    }

    if (!actData) {
      const actRows = results[idx].rows;
      idx++;
      finalAct = actRows.map(r => ({
        id: r.id,
        type: r.activity_type,
        description: r.description,
        amount: parseFloat(r.amount || 0),
        currency: r.currency || 'USD',
        date: r.created_at,
        category: r.category_name,
        expenseDescription: r.expense_description,
      }));
    }

    if (!groupsData) {
      const groupRows = results[idx].rows;
      finalGroups = groupRows.map(r => ({
        id: r.id,
        name: r.name,
        description: r.description,
        group_type: r.group_type,
        default_currency: r.default_currency,
        avatar_url: r.avatar_url,
        invite_code: r.invite_code,
        created_at: r.created_at,
        created_by_name: r.created_by_name,
        member_count: parseInt(r.member_count, 10),
        user_role: r.user_role,
      }));
    }

    // ── 4. Write back to cache (fire-and-forget) ─────────────────────────────
    // FIX: Use fire-and-forget (.catch) instead of awaiting twice.
    // Previously the code awaited cache writes a second time after already
    // writing them in the !dashData / !actData / !groupsData blocks, which
    // could overwrite a fresher value written by a concurrent request.
    redis().set(cacheKey.dashboard(user_id), JSON.stringify(finalDash), { ex: CACHE_TTL.dashboard }).catch(e => console.warn('Cache write failed:', e.message));
    redis().set(cacheKey.groups(user_id), JSON.stringify(finalGroups), { ex: CACHE_TTL.groups }).catch(e => console.warn('Cache write failed:', e.message));
    redis().set(cacheKey.activity(user_id), JSON.stringify(finalAct), { ex: CACHE_TTL.activity }).catch(e => console.warn('Cache write failed:', e.message));

    // ── 5. Respond ───────────────────────────────────────────────────────────
    res.json({
      success: true,
      fromCache: false,
      data: {
        ...finalDash,
        recentActivity: finalAct,
        groups: finalGroups,
      },
    });

  } catch (error) {
    console.error('Dashboard Error:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching dashboard data' });
  }
};