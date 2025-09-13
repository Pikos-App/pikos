import { writable } from "svelte/store";

export type ModalType = "page-switcher";

type ModalState =
  | {
      current: ModalType | undefined;
      props?: Record<string, unknown>;
    }
  | undefined;

const initialState: ModalState = undefined;

const modalStore = writable<ModalState>(initialState);

export const modal = {
  subscribe: modalStore.subscribe,

  open: (type: ModalType, props: Record<string, unknown> = {}) => {
    modalStore.set({ current: type, props });
  },

  close: (type?: ModalType) => {
    modalStore.update((state) => {
      if (!state) return undefined;
      if (!type || state.current === type) {
        return undefined;
      }
      return state;
    });
  },

  reset: () => {
    modalStore.set(undefined);
  },

  isOpen: (type: ModalType) => {
    let isOpen = false;
    modalStore.subscribe((state) => {
      isOpen = state?.current === type;
    })();
    return isOpen;
  },

  getProps: () => {
    let props = {};
    modalStore.subscribe((state) => {
      props = state?.props || {};
    })();
    return props;
  },
};
