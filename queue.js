// queue.js — простая очередь задач для отправки сообщений

class MessageQueue {
  constructor(delay = 500) {
    this.queue = [];
    this.isProcessing = false;
    this.delay = delay; // задержка между отправками
  }

  add(task) {
    this.queue.push(task);
    this.process();
  }

  async process() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift();

      try {
        await task();
      } catch (err) {
        console.error("Ошибка выполнения задачи очереди:", err.message);
      }

      await new Promise(res => setTimeout(res, this.delay));
    }

    this.isProcessing = false;
  }
}

module.exports = new MessageQueue(700); // задержка 700 мс между отправками
