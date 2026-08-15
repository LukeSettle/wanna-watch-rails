Rails.application.routes.draw do
  get 'auth/me'
  post 'auth/register'
  post 'auth/login'
  post 'auth/logout'
  post 'auth/forgot'
  post 'auth/reset'

  post 'users/upsert'
  get 'users/find_by_device_id'
  get 'friends/index'
  get 'friends/movie_ids'

  resources :game_invites, only: [:index, :create] do
    member do
      post :accept
      post :decline
    end
  end

  resources :games, only: [:index] do
    member do
      post :finish
      post :join
      post :leave
      post :ready
      post :finish_matching
      post :swipe
      get :deck
    end
  end
  get 'games/previous'
  post 'games/upsert'
  get 'games/find_by_entry_code'
  post 'games/keep_playing'

  get 'home', to: 'application#home'
  root to: 'web#show'
end
