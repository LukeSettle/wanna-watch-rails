class AddSubscriptionFieldsToUsers < ActiveRecord::Migration[7.1]
  def change
    add_column :users, :stripe_subscription_id, :string
    add_column :users, :subscription_status, :string
    add_index :users, :stripe_subscription_id,
              unique: true,
              where: "stripe_subscription_id IS NOT NULL"
  end
end
