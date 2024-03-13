class CreateGames < ActiveRecord::Migration[7.1]
  def change
    create_table :games do |t|
      t.string :entry_code
      t.text :query
      t.references :user, null: false, foreign_key: true

      t.timestamps
    end
  end
end
