import { createApp } from 'vue';
import { createPinia } from 'pinia';
import PetApp from './PetApp.vue';
import './styles/theme.css';
import './styles/main.css';

createApp(PetApp).use(createPinia()).mount('#app');
