# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[7.1].define(version: 2026_08_15_200000) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "plpgsql"

  create_table "game_invites", force: :cascade do |t|
    t.bigint "game_id", null: false
    t.bigint "inviter_id", null: false
    t.bigint "invitee_id", null: false
    t.string "status", default: "pending", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["game_id", "invitee_id", "status"], name: "index_game_invites_on_game_id_and_invitee_id_and_status"
    t.index ["game_id"], name: "index_game_invites_on_game_id"
    t.index ["invitee_id", "status"], name: "index_game_invites_on_invitee_id_and_status"
    t.index ["invitee_id"], name: "index_game_invites_on_invitee_id"
    t.index ["inviter_id"], name: "index_game_invites_on_inviter_id"
  end

  create_table "games", force: :cascade do |t|
    t.string "entry_code"
    t.text "query"
    t.bigint "user_id", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.datetime "started_at"
    t.datetime "finished_at"
    t.integer "load_more_count", default: 0
    t.jsonb "deck", default: []
    t.integer "deck_round", default: -1
    t.string "mode", default: "classic", null: false
    t.text "dealt_movie_ids", default: [], array: true
    t.index ["user_id"], name: "index_games_on_user_id"
  end

  create_table "players", force: :cascade do |t|
    t.datetime "finished_at"
    t.datetime "ready_at"
    t.bigint "user_id", null: false
    t.bigint "game_id", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.text "liked_movie_ids", default: [], array: true
    t.text "seen_movie_ids", default: [], array: true
    t.index ["game_id"], name: "index_players_on_game_id"
    t.index ["user_id", "game_id"], name: "index_players_on_user_id_and_game_id", unique: true
    t.index ["user_id"], name: "index_players_on_user_id"
  end

  create_table "purchases", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "product_id", null: false
    t.string "stripe_session_id"
    t.string "stripe_payment_intent"
    t.integer "amount_cents", default: 0, null: false
    t.string "currency", default: "usd", null: false
    t.string "status", default: "completed", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["stripe_session_id"], name: "index_purchases_on_stripe_session_id", unique: true, where: "(stripe_session_id IS NOT NULL)"
    t.index ["user_id"], name: "index_purchases_on_user_id"
  end

  create_table "users", force: :cascade do |t|
    t.string "device_id"
    t.string "username"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "providers", default: [], array: true
    t.string "email"
    t.string "password_digest"
    t.string "reset_token_digest"
    t.datetime "reset_token_sent_at"
    t.string "phone"
    t.jsonb "notification_preferences", default: {}, null: false
    t.string "stripe_customer_id"
    t.boolean "ad_free", default: false, null: false
    t.jsonb "entitlements", default: {}, null: false
    t.index ["email"], name: "index_users_on_email", unique: true, where: "(email IS NOT NULL)"
    t.index ["phone"], name: "index_users_on_phone", unique: true, where: "(phone IS NOT NULL)"
    t.index ["stripe_customer_id"], name: "index_users_on_stripe_customer_id", unique: true, where: "(stripe_customer_id IS NOT NULL)"
  end

  add_foreign_key "game_invites", "games"
  add_foreign_key "game_invites", "users", column: "invitee_id"
  add_foreign_key "game_invites", "users", column: "inviter_id"
  add_foreign_key "games", "users"
  add_foreign_key "players", "games"
  add_foreign_key "players", "users"
  add_foreign_key "purchases", "users"
end
