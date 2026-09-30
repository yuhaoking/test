import { createApp } from 'vue';
import { createPinia } from 'pinia';
import SettingsApp from './SettingsApp.vue';
import './styles/theme.css';
import './styles/main.css';

createApp(SettingsApp).use(createPinia()).mount('#app');
