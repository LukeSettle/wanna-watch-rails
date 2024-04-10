class AddProvidersToUsers < ActiveRecord::Migration[7.1]
  def change
    add_column :users, :providers, :string, array: true, default: []
  end
end
