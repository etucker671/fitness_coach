INSERT INTO user_goals (id, plan_data) VALUES (
  1,
  '{
    "program_metadata": {
      "name": "30-Day Shred",
      "primary_goal": "Reduce body fat while maintaining/increasing strength",
      "target_weight_loss_rate": "0.5 - 1.0 lb/week",
      "global_rules": [
        "Daily Protein Target: 180-200g",
        "Daily Step Target: 8,000 - 10,000 steps",
        "Hydrate consistently (add electrolytes on heavy sweat days)",
        "Carbs centered around harder training sessions",
        "7+ hours sleep per night",
        "Avoid increasing load and conditioning volume simultaneously"
      ]
    },
    "macro_targets": {
      "high_carb_days": { "days": ["Monday", "Wednesday", "Friday", "Saturday"], "calories": 2300, "protein_g": 190, "carbs_g": 175, "fat_g": 70 },
      "low_carb_days": { "days": ["Tuesday", "Thursday", "Sunday"], "calories": 2150, "protein_g": 190, "carbs_g": 75, "fat_g": 90 }
    },
    "weekly_workout_schedule": {
      "Monday": { "type": "LOWER + CORE", "carb_category": "HIGH CARB" },
      "Tuesday": { "type": "INTERVALS", "carb_category": "LOW CARB" },
      "Wednesday": { "type": "UPPER", "carb_category": "HIGH CARB" },
      "Thursday": { "type": "YOGA / ZONE 2", "carb_category": "LOW CARB" },
      "Friday": { "type": "FULL-BODY METABOLIC", "carb_category": "HIGH CARB" },
      "Saturday": { "type": "LONG AEROBIC", "carb_category": "HIGH CARB" },
      "Sunday": { "type": "OFF / RECOVERY", "carb_category": "LOW CARB" }
    }
  }'::jsonb
);