class AddPhoneAndNotificationPreferencesToUsers < ActiveRecord::Migration[7.1]
  def change
    add_column :users, :phone, :string
    add_column :users, :notification_preferences, :jsonb, default: {}, null: false
    add_index :users, :phone, unique: true, where: "phone IS NOT NULL"
  end
end
