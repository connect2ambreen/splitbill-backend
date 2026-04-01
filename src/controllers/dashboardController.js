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
      redis.del(cacheKey.dashboard(userId)),
      redis.del(cacheKey.groups(userId)),
      redis.del(cacheKey.activity(userId)),
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
    const [cachedDash, cachedGroups, cachedActivity] = await Promise.allSettled([
      redis.get(cacheKey.dashboard(user_id)),
      redis.get(cacheKey.groups(user_id)),
      redis.get(cacheKey.activity(user_id)),
    ]);

    const dashData = cachedDash.status === 'fulfilled' ? cachedDash.value : null;
    const groupsData = cachedGroups.status === 'fulfilled' ? cachedGroups.value : null;
    const actData = cachedActivity.status === 'fulfilled' ? cachedActivity.value : null;

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

    // Always run core dashboard queries if dashData is missing
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

        // Current month
        query(`
          SELECT COALESCE(SUM(es.owed_share), 0) as total
          FROM expense_shares es
          JOIN expenses e ON es.expense_id = e.id
          WHERE es.user_id = $1
            AND DATE_TRUNC('month', e.created_at) = DATE_TRUNC('month', CURRENT_DATE)
            AND e.is_deleted = false`, [user_id]),

        // Previous month
        query(`
          SELECT COALESCE(SUM(es.owed_share), 0) as total
          FROM expense_shares es
          JOIN expenses e ON es.expense_id = e.id
          WHERE es.user_id = $1
            AND DATE_TRUNC('month', e.created_at) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
            AND e.is_deleted = false`, [user_id]),

        // Weekly
        query(`
          WITH week_numbers AS (SELECT generate_series(1, 5) as week_num),
          week_ranges AS (
            SELECT
              week_num,
              DATE_TRUNC('month', CURRENT_DATE) + ((week_num - 1) * 7 || ' days')::interval as week_start,
              DATE_TRUNC('month', CURRENT_DATE) + (week_num * 7 || ' days')::interval as week_end
            FROM week_numbers
          )
          SELECT wr.week_num, COALESCE(SUM(es.owed_share), 0) as amount
          FROM week_ranges wr
          LEFT JOIN expenses e ON
            e.created_at >= wr.week_start AND e.created_at < wr.week_end
            AND e.created_at >= DATE_TRUNC('month', CURRENT_DATE)
            AND e.created_at < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
            AND e.is_deleted = false
          LEFT JOIN expense_shares es ON es.expense_id = e.id AND es.user_id = $1
          GROUP BY wr.week_num ORDER BY wr.week_num LIMIT 5`, [user_id]),

        // Category
        query(`
          SELECT
            LOWER(COALESCE(ec.name, 'uncategorized')) AS category,
            COALESCE(SUM(es.owed_share), 0) AS amount
          FROM expense_shares es
          JOIN expenses e ON es.expense_id = e.id
          LEFT JOIN expense_categories ec ON e.category_id = ec.id
          WHERE es.user_id = $1 AND e.is_deleted = false
            AND e.created_at >= DATE_TRUNC('month', CURRENT_DATE)
            AND e.created_at < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
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
      const [balance, monthly, previous, weekly, category] = results.slice(0, 5);
      idx = 5;

      const weeklyData = weekly.rows.map(r => parseFloat(r.amount));

      const categoryData = { food: 0, transport: 0, entertainment: 0, utilities: 0 };
      category.rows.forEach(r => {
        if (Object.prototype.hasOwnProperty.call(categoryData, r.category)) {
          categoryData[r.category] = parseFloat(r.amount);
        }
      });

      const changePercent = parseFloat(previous.rows[0].total) > 0
        ? Math.round(
          ((parseFloat(monthly.rows[0].total) - parseFloat(previous.rows[0].total))
            / parseFloat(previous.rows[0].total)) * 100
        )
        : 0;

      finalDash = {
        balance: {
          youOwe: parseFloat(balance.rows[0].you_owe),
          youAreOwed: parseFloat(balance.rows[0].you_are_owed),
        },
        monthlyStats: { totalThisMonth: parseFloat(monthly.rows[0].total), changePercent },
        weeklyData,
        categoryData,
      };

      // Store core dashboard data
      redis.set(cacheKey.dashboard(user_id), finalDash, { ex: CACHE_TTL.dashboard })
        .catch(err => console.warn('Cache write failed:', err.message));
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

      redis.set(cacheKey.activity(user_id), finalAct, { ex: CACHE_TTL.activity })
        .catch(err => console.warn('Cache write failed:', err.message));
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
        member_count: parseInt(r.member_count),
        user_role: r.user_role,
      }));

      redis.set(cacheKey.groups(user_id), finalGroups, { ex: CACHE_TTL.groups })
        .catch(err => console.warn('Cache write failed:', err.message));
    }

    // ── 4. Respond ───────────────────────────────────────────────────────────
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