class AddMonetizationToUsers < ActiveRecord::Migration[7.1]
  def change
    add_column :users, :stripe_customer_id, :string
    add_column :users, :ad_free, :boolean, default: false, null: false
    add_column :users, :entitlements, :jsonb, default: {}, null: false
    add_index :users, :stripe_customer_id, unique: true, where: "stripe_customer_id IS NOT NULL"

    create_table :purchases do |t|
      t.references :user, null: false, foreign_key: true
      t.string :product_id, null: false
      t.string :stripe_session_id
      t.string :stripe_payment_intent
      t.integer :amount_cents, null: false, default: 0
      t.string :currency, null: false, default: "usd"
      t.string :status, null: false, default: "completed"
      t.timestamps
    end

    add_index :purchases, :stripe_session_id, unique: true, where: "stripe_session_id IS NOT NULL"
  end
end
