class AddAuthToUsers < ActiveRecord::Migration[7.1]
  def change
    add_column :users, :email, :string
    add_column :users, :password_digest, :string
    add_column :users, :reset_token_digest, :string
    add_column :users, :reset_token_sent_at, :datetime
    add_index :users, :email, unique: true, where: "email IS NOT NULL"
  end
end
