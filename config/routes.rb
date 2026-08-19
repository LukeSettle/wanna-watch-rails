Rails.application.routes.draw do
  get 'auth/me'
  post 'auth/register'
  post 'auth/login'
  post 'auth/logout'
  post 'auth/forgot'
  post 'auth/reset'
  post 'auth/update'

  post 'users/upsert'
  get 'users/find_by_device_id'
  get 'friends/index'
  get 'friends/movie_ids'

  resources :game_invites, only: [:index, :create] do
    member do
      post :accept
      post :decline
      post :nudge
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
      post :undo_swipe
      get :deck
    end
  end
  get 'games/previous'
  post 'games/upsert'
  get 'games/find_by_entry_code'
  post 'games/keep_playing'

  get 'shop/catalog', to: 'shop#catalog'
  get 'shop/entitlements', to: 'shop#entitlements'
  post 'shop/checkout', to: 'shop#checkout'
  post 'shop/portal', to: 'shop#portal'
  post 'shop/confirm', to: 'shop#confirm'
  post 'stripe/webhook', to: 'stripe_webhooks#create'

  get 'home', to: 'application#home'
  get 'about', to: 'pages#about'
  get 'how-it-works', to: 'pages#how_it_works'
  get 'privacy', to: 'pages#privacy'
  get 'contact', to: 'pages#contact'

  root to: 'web#show'
end
