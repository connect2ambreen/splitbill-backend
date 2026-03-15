// Simplified Dashboard APIs
import { query } from "../config/db.js";

export const getDashboardData = async (req, res) => {
  try {
    const { user_id } = req.params;

    const [balance, monthly, previous, weekly, category, activity, groups] = await Promise.all([
      // Balance calculation
      query(`
        SELECT 
          COALESCE(SUM(CASE WHEN es.paid_share > es.owed_share THEN es.paid_share - es.owed_share ELSE 0 END), 0) as you_are_owed,
          COALESCE(SUM(CASE WHEN es.owed_share > es.paid_share THEN es.owed_share - es.paid_share ELSE 0 END), 0) as you_owe
        FROM expense_shares es
        JOIN expenses e ON es.expense_id = e.id
        WHERE es.user_id = $1 AND e.is_deleted = false`, [user_id]),

      // Current month total
      query(`
        SELECT COALESCE(SUM(es.owed_share), 0) as total
        FROM expense_shares es
        JOIN expenses e ON es.expense_id = e.id
        WHERE es.user_id = $1 AND DATE_TRUNC('month', e.created_at) = DATE_TRUNC('month', CURRENT_DATE) AND e.is_deleted = false`, [user_id]),

      // Previous month total
      query(`
        SELECT COALESCE(SUM(es.owed_share), 0) as total
        FROM expense_shares es
        JOIN expenses e ON es.expense_id = e.id
        WHERE es.user_id = $1 AND DATE_TRUNC('month', e.created_at) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month') AND e.is_deleted = false`, [user_id]),

      // Weekly data - Fixed query
      query(` 
        WITH week_numbers AS (
          SELECT 
            generate_series(1, 5) as week_num
        ),
        week_ranges AS (
          SELECT 
            week_num,
            DATE_TRUNC('month', CURRENT_DATE) + ((week_num - 1) * 7 || ' days')::interval as week_start,
            DATE_TRUNC('month', CURRENT_DATE) + (week_num * 7 || ' days')::interval as week_end
          FROM week_numbers
        )
        SELECT 
          wr.week_num,
          COALESCE(SUM(es.owed_share), 0) as amount
        FROM week_ranges wr
        LEFT JOIN expenses e ON 
          e.created_at >= wr.week_start 
          AND e.created_at < wr.week_end
          AND e.created_at >= DATE_TRUNC('month', CURRENT_DATE)
          AND e.created_at < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
          AND e.is_deleted = false
        LEFT JOIN expense_shares es ON 
          es.expense_id = e.id 
          AND es.user_id = $1
        GROUP BY wr.week_num
        ORDER BY wr.week_num
        LIMIT 5`, [user_id]),

      // Category data
      query(`
        SELECT 
          LOWER(COALESCE(ec.name, 'uncategorized')) AS category,
          COALESCE(SUM(es.owed_share), 0) AS amount
        FROM expense_shares es
        JOIN expenses e ON es.expense_id = e.id
        LEFT JOIN expense_categories ec ON e.category_id = ec.id
        WHERE es.user_id = $1
          AND e.is_deleted = false
          AND e.created_at >= DATE_TRUNC('month', CURRENT_DATE)
          AND e.created_at < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
        GROUP BY LOWER(COALESCE(ec.name, 'uncategorized'))
      `, [user_id]),

      // Recent activity
      query(`
        SELECT a.id, a.activity_type, a.description, a.amount, a.currency, a.created_at,
               e.description as expense_description, ec.name as category_name
        FROM activities a
        LEFT JOIN expenses e ON a.related_expense_id = e.id
        LEFT JOIN expense_categories ec ON e.category_id = ec.id
        WHERE a.user_id = $1 OR a.group_id IN (SELECT group_id FROM group_members WHERE user_id = $1)
        ORDER BY a.created_at DESC LIMIT 10`, [user_id]),

      // User's groups - NEW!
      query(`
        SELECT 
          g.id,
          g.name,
          g.description,
          g.group_type,
          g.default_currency,
          g.avatar_url,
          g.invite_code,
          g.created_at,
          u.name as created_by_name,
          COUNT(DISTINCT gm.user_id) as member_count,
          gm_current.role as user_role
        FROM groups g
        JOIN group_members gm_current ON g.id = gm_current.group_id AND gm_current.user_id = $1
        LEFT JOIN group_members gm ON g.id = gm.group_id AND gm.is_active = true
        LEFT JOIN users u ON g.created_by = u.id
        WHERE gm_current.is_active = true 
          AND g.is_active = true
        GROUP BY g.id, g.name, g.description, g.group_type, g.default_currency, 
                 g.avatar_url, g.invite_code, g.created_at, u.name, gm_current.role
        ORDER BY g.created_at DESC
      `, [user_id])
    ]);

    // Process weekly data
    const weeklyData = weekly.rows.map(row => parseFloat(row.amount));

    // Process category data
    const categoryData = { food: 0, transport: 0, entertainment: 0, utilities: 0 };
    category.rows.forEach(row => {
      if (categoryData.hasOwnProperty(row.category)) {
        categoryData[row.category] = parseFloat(row.amount);
      }
    });

    // Calculate change percentage
    const changePercent = parseFloat(previous.rows[0].total) > 0
      ? Math.round(((parseFloat(monthly.rows[0].total) - parseFloat(previous.rows[0].total)) / parseFloat(previous.rows[0].total)) * 100)
      : 0;

    res.json({
      success: true,
      data: {
        balance: {
          youOwe: parseFloat(balance.rows[0].you_owe),
          youAreOwed: parseFloat(balance.rows[0].you_are_owed)
        },
        monthlyStats: {
          totalThisMonth: parseFloat(monthly.rows[0].total),
          changePercent
        },
        weeklyData,
        categoryData,
        recentActivity: activity.rows.map(row => ({
          id: row.id,
          type: row.activity_type,
          description: row.description,
          amount: parseFloat(row.amount || 0),
          currency: row.currency || 'USD',
          date: row.created_at,
          category: row.category_name,
          expenseDescription: row.expense_description
        })),
        // Groups data - NEW!
        groups: groups.rows.map(row => ({
          id: row.id,
          name: row.name,
          description: row.description,
          group_type: row.group_type,
          default_currency: row.default_currency,
          avatar_url: row.avatar_url,
          invite_code: row.invite_code,
          created_at: row.created_at,
          created_by_name: row.created_by_name,
          member_count: parseInt(row.member_count),
          user_role: row.user_role
        }))
      }
    });
  } catch (error) {
    console.error('Dashboard Error:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching dashboard data' });
  }
};