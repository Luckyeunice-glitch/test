/* UniShare presentation build: local-only storage. No Firebase/account sync. */
(() => {
  'use strict';
  if (window.quizStudyStorage) return;
  const prefix = 'UniShare_';
  window.quizStudyStorage = {
    lockOwner(){},
    unlockOwner(){},
    adoptGuestOnNextLogin(){},
    cancelAdoption(){},
    getItem(key){ try { return localStorage.getItem(prefix + key); } catch { return null; } },
    setItem(key,value){ try { localStorage.setItem(prefix + key, String(value)); } catch {} },
    removeItem(key){ try { localStorage.removeItem(prefix + key); } catch {} },
    clear(){
      try { Object.keys(localStorage).filter(k=>k.startsWith(prefix)).forEach(k=>localStorage.removeItem(k)); } catch {}
    }
  };
})();
